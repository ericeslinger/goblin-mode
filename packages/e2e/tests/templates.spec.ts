import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Templates (#38): made in Settings, edited like any note, with their
// Instructions for Claude on the back of the note (#111, #112); From
// template starts a fresh entry or reopens the living note; Claude reads
// the instructions through list_templates and use_template.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function makeTemplate(
  page: Page,
  button: string,
  lines: string[],
  instructions: string,
): Promise<string> {
  await page.goto('/settings');
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect(page).toHaveURL(/\/n\/\w+$/);
  await expect(page.getByRole('region', { name: 'Template' })).toBeVisible();
  await note(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await typeLines(page, lines);
  await letItSave(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  // From template names a template by its title, which can arrive after
  // the text does (#226): return once the back reads the first line.
  await expect(
    page
      .getByRole('region', { name: 'Back of the note' })
      .getByRole('heading', { level: 2, name: lines[0], exact: true }),
  ).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Instructions for Claude' });
  await box.fill(instructions);
  // Saved on leaving the field, as a phone finishes.
  await box.blur();
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
  await makeTemplate(page, 'New template', ['Journal entry', 'Mood: '], 'Ask how the day went.');
  const living = await makeTemplate(
    page,
    'New living template',
    ['Shopping list', '## Produce'],
    'Start from the meal plan.',
  );
  await expect(page.getByRole('combobox', { name: 'Each use' })).toHaveValue('living');
  await noSeriousViolations(page);
  // The text Eric writes in never holds them.
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await expect(note(page)).not.toContainText('Start from the meal plan');
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

// Document modes (#231): any note can say how it takes new material, on
// its back beside its own Instructions for Claude; on a Log, Claude's
// add_lines goes under a heading for today's date.
test('a note set to Log on its back takes Claude’s lines under today’s date', async ({ page }) => {
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  const { id } = (await call('create_note', { body: 'Kiln log\nFirst firing of the year' })) as {
    id: string;
  };
  await page.goto(`/n/${id}`);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const back = page.getByRole('region', { name: 'Back of the note' });
  const takes = back.getByRole('combobox', { name: 'Takes new material as' });
  await takes.selectOption('log');
  await expect(back).toContainText('Claude adds under today’s date');
  const box = back.getByRole('textbox', { name: 'Instructions for Claude' });
  await box.fill('Say the cone.');
  await box.blur();
  await noSeriousViolations(page);

  await expect
    .poll(async () => ((await call('get_note', { id })) as { takes?: { mode?: string } }).takes, {
      timeout: 15_000,
    })
    .toEqual(
      expect.objectContaining({
        mode: 'log',
        modeBrief: expect.stringContaining('Instructions for Claude: Say the cone.'),
      }),
    );
  // The server's day, UTC with no time zone given.
  const today = new Date().toISOString().slice(0, 10);
  await call('add_lines', { id, lines: ['✳ Claude: Glazed the bowls, cone 6.'] });
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await expect(note(page)).toHaveText(
    new RegExp(`First firing of the year[\\s\\S]*${today}[\\s\\S]*Glazed the bowls, cone 6\\.`),
  );
});
