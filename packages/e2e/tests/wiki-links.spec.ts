import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Wiki links (#29): `[[` suggests names, a tapped link opens its note,
// and a new name becomes a concept.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });
const chip = (page: Page, name: string) => note(page).getByRole('link', { name, exact: true });

async function newNote(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test('[[ suggests a note, and the link opens it; back returns', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Pottery class schedule']);
  await letItSave(page);
  await newNote(page);

  await page.keyboard.type('Bring clay to [[pott');
  const option = page.getByRole('option', { name: /Pottery class schedule/ });
  await expect(option).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await option.click();
  await expect(note(page)).toContainText('[[Pottery class schedule]]');
  // Off the link's line, it shows as a chip.
  await typeLines(page, ['', 'and an apron']);
  await letItSave(page);

  await chip(page, 'Pottery class schedule').click();
  await expect(page).toHaveURL(/\/n\/\w+$/);
  await expect(note(page)).toContainText('Pottery class schedule');
  await page.goBack();
  await expect(note(page)).toContainText('Bring clay to');
});

test('a link to a new name makes a concept, offline too', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.context().setOffline(true);
  await typeLines(page, ['Plan the [[Kiln repair]]', 'before Friday']);
  await letItSave(page);

  await chip(page, 'Kiln repair').click();
  await expect(page).toHaveURL(/\/n\/c-kiln-repair$/);
  // The concept exists at once: editable, ready for its own text.
  await expect(note(page)).toHaveAttribute('contenteditable', 'true');
  await typeLines(page, ['Needs a new element']);
  await letItSave(page);
  await page.context().setOffline(false);

  await page.goBack();
  await expect(note(page)).toContainText('Plan the');
  await page.goForward();
  await expect(note(page)).toContainText('Needs a new element');
});

test('leaving a note makes concepts for the new names it links', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Call [[Aunt Ruth]] on Sunday']);
  await letItSave(page);
  await newNote(page);
  await page.goto('/n/c-aunt-ruth');
  await expect(note(page)).toHaveAttribute('contenteditable', 'true');
  await expect(page.getByText('reached this device')).toHaveCount(0);
});
