import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The concept page (#30): name, type and other names above the text;
// the notes that link here, each with its sentence; concepts often
// linked alongside.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });
const chip = (page: Page, name: string) => note(page).getByRole('link', { name, exact: true });

async function write(page: Page, lines: string[]): Promise<void> {
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, lines);
  await letItSave(page);
}

test('a concept shows who links to it, and keeps its links through a rename', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Studio day', 'Ask [[Vikas]] about the kiln. Then glaze.', 'clay']);
  await letItSave(page);
  await write(page, ['Lunch plans', '[[Vik]] and [[Kiln]] after noon']);
  await write(page, ['Firing notes', 'Bring [[Vikas]] and the [[Kiln]] log.']);

  // Through the first note's link to the concept.
  await page.goto('/browse');
  await page
    .getByRole('list', { name: 'Notes' })
    .getByRole('link', { name: /Studio day/ })
    .click();
  await chip(page, 'Vikas').click();
  await expect(page).toHaveURL(/\/n\/c-vikas$/);

  const concept = page.getByRole('region', { name: 'Concept' });
  await expect(concept.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Vikas');
  await concept.getByRole('combobox', { name: 'Type' }).selectOption('person');
  await concept.getByRole('textbox', { name: 'Add another name' }).fill('Vik');
  await concept.getByRole('textbox', { name: 'Add another name' }).press('Enter');
  await expect(concept.getByRole('list', { name: 'Also called' })).toContainText('Vik');

  const linkedFrom = page.getByRole('region', { name: 'Linked from' });
  await expect(linkedFrom).toContainText('Ask [[Vikas]] about the kiln.');
  await expect(linkedFrom).toContainText('Firing notes');
  // "Vik" now answers to the concept, so the lunch note links here too.
  await expect(linkedFrom).toContainText('Lunch plans');
  await expect(page.getByRole('region', { name: 'Often together' })).toContainText('Kiln');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Rename: the old name stays, so the old links still land here.
  const name = concept.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Vikas S.');
  await name.press('Enter');
  await expect(concept.getByRole('list', { name: 'Also called' })).toContainText('Vikas');
  await linkedFrom.getByRole('link', { name: 'Studio day' }).click();
  await chip(page, 'Vikas').click();
  await expect(page).toHaveURL(/\/n\/c-vikas$/);
  await expect(concept.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Vikas S.');

  // A concept emptied of text is still a concept, never deleted.
  await note(page).click();
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await letItSave(page);
  await page.reload();
  await expect(concept.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Vikas S.');
  await expect(concept.getByRole('list', { name: 'Also called' })).toContainText('Vik');
});
