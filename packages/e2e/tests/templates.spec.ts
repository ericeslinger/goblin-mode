import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Templates (#38): made in Settings, edited like any note; From template
// starts a fresh entry or reopens the living note; Claude reads the
// instructions through list_templates and use_template.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function makeTemplate(page: Page, button: string, lines: string[]): Promise<string> {
  await page.goto('/settings');
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect(page).toHaveURL(/\/n\/\w+$/);
  await expect(page.getByRole('region', { name: 'Template' })).toBeVisible();
  await note(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await typeLines(page, lines);
  await letItSave(page);
  return page.url();
}

async function fromTemplate(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'From template' }).click();
  await page.getByRole('list', { name: 'Templates' }).getByRole('button', { name }).click();
  await expect(page).toHaveURL(/\/n\/\w+$/);
  return page.url();
}

test('templates start a new entry or reopen the living note, and Claude can use them', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  await makeTemplate(page, 'New template', [
    'Journal entry',
    'Mood: ',
    '',
    '## Instructions for Claude',
    'Ask how the day went.',
  ]);
  const living = await makeTemplate(page, 'New living template', [
    'Shopping list',
    '## Produce',
    '',
    '## Instructions for Claude',
    'Start from the meal plan.',
  ]);
  await expect(page.getByRole('combobox', { name: 'Each use' })).toHaveValue('living');
  expect(living).toBeTruthy();

  await page.goto('/settings');
  const list = page.getByRole('list', { name: 'Templates' });
  await expect(list).toContainText('Journal entry');
  await expect(list).toContainText('one note, reused');
  await noSeriousViolations(page);

  // A new entry each time, from the skeleton alone.
  const first = await fromTemplate(page, 'Journal entry');
  await expect(note(page)).toContainText('Mood:');
  await expect(note(page)).not.toContainText('Instructions for Claude');
  await noSeriousViolations(page);
  await note(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('calm');
  await letItSave(page);
  const second = await fromTemplate(page, 'Journal entry');
  expect(second).not.toBe(first);

  // The living note is the same note every time.
  const shopping = await fromTemplate(page, 'Shopping list');
  await note(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await typeLines(page, ['', 'apples']);
  await letItSave(page);
  expect(await fromTemplate(page, 'Shopping list')).toBe(shopping);
  await expect(note(page)).toContainText('apples');

  // Templates are not among the notes.
  await page.goto('/browse');
  await expect(page.getByRole('list', { name: 'Notes' })).not.toContainText('Journal entry\n');

  // Claude gets the instructions, and the living note.
  const call = await connectClaude(page);
  const templates = (await call('list_templates', {})) as {
    id: string;
    title: string;
    instructions: string;
  }[];
  expect(templates.map((t) => [t.title, t.instructions])).toEqual([
    ['Journal entry', 'Ask how the day went.'],
    ['Shopping list', 'Start from the meal plan.'],
  ]);
  const shoppingId = shopping.split('/n/')[1];
  const shoppingTemplate = templates.find((t) => t.title === 'Shopping list')!;
  const used = (await call('use_template', { id: shoppingTemplate.id })) as {
    created: boolean;
    note: { id: string };
  };
  expect(used).toMatchObject({ created: false, note: { id: shoppingId } });
});
