import AxeBuilder from '@axe-core/playwright';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Browse lenses (#31): Recent, Concepts, People, Projects, Tags and
// Archived, each with a count and its own URL.

test('lenses sort the garden, each at its own URL', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Studio day', 'Ask [[Vikas]] about the [[Kiln]].', 'clay']);
  await letItSave(page);
  // Leaving the note makes the two concepts.
  await page.getByRole('button', { name: 'New' }).click();

  await page.goto('/browse/concepts');
  const notes = page.getByRole('list', { name: 'Notes' });
  await expect(notes).toContainText('Vikas');
  await expect(notes).toContainText('Linked from 1 note');
  await expect(notes).not.toContainText('Studio day');

  // Make Vikas a person; the People lens and its count follow.
  await notes.getByRole('link', { name: /Vikas/ }).click();
  await page.getByRole('combobox', { name: 'Type' }).selectOption('person');
  await page.goBack();
  await expect(page).toHaveURL(/\/browse\/concepts$/);

  const lenses = page.getByRole('navigation', { name: 'Lenses' });
  await lenses.getByRole('link', { name: /^People/ }).click();
  await expect(page).toHaveURL(/\/browse\/people$/);
  await expect(lenses.getByRole('link', { name: /^People/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(lenses.getByRole('link', { name: /^People/ })).toContainText('1');
  await expect(notes).toContainText('Vikas');
  await expect(notes).not.toContainText('Kiln');

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await lenses.getByRole('link', { name: /^Recent/ }).click();
  await expect(page).toHaveURL(/\/browse$/);
  await expect(notes).toContainText('Studio day');
  await page.goBack();
  await expect(page).toHaveURL(/\/browse\/people$/);
});
