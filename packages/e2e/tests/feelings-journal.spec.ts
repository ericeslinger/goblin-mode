import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  expect,
  letItSave,
  openMore,
  signInAs,
  test,
  typeLines,
  openSettings,
} from '../src/fixtures';
import { OWNER } from '../src/personas';

// The feelings journal (#40): a template from Settings with three daily
// reminders that each open a new entry; moods on the Moods line are
// concepts of type mood, offered again the next time.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

test('a feelings journal: reminders open entries, moods grow and come back', async ({ page }) => {
  await signInAs(page, OWNER);
  await openSettings(page, 'Templates');
  await page.getByRole('button', { name: 'Add a feelings journal' }).click();
  await expect(page.getByRole('region', { name: 'Template' })).toBeVisible();

  // A reminder opens a new entry, not the template. The template and
  // its three reminders are written at the tap; a reload within
  // milliseconds of it, quicker than any gardener's, lost the reminders
  // under load (2026-11-17, as the Reader's undo in #319), so the
  // writes land first.
  await letItSave(page);
  await page.goto('/right-now');
  await page.getByRole('link', { name: 'Feelings journal: breakfast' }).click();
  await expect(page).toHaveURL(/\/n\/[A-Za-z0-9]+$/);
  await expect(page.getByRole('region', { name: 'Template' })).toHaveCount(0);
  await expect(note(page)).toContainText('Moods:');
  await expect(note(page)).toContainText('What helped');

  // A first mood: offered as new, written as a link.
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, ['Feelings', 'Moods: wist']);
  await page.getByRole('option', { name: /wist.*new mood/ }).click();
  await expect(note(page)).toContainText('[[wist]],');
  await page.keyboard.press('Enter');
  await page.keyboard.type('slow morning');
  await letItSave(page);

  // Leaving the entry makes the mood, as a mood.
  await page.getByRole('button', { name: 'New' }).click();
  await page.goto('/n/c-wist');
  const concept = page.getByRole('region', { name: 'Concept' });
  await expect(concept.getByRole('combobox', { name: 'Type' })).toHaveValue('mood');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Linked from' })).toContainText('Feelings');

  // Next time, it is offered, once the notes have loaded.
  await page.goto('/');
  // Previous note, in More since 2026-11-15 (#287), shows once they have.
  const more = await openMore(page);
  await expect(more.getByRole('button', { name: 'Previous note' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toHaveCount(0);
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, ['Feelings', 'Moods: wi']);
  await expect(page.getByRole('option', { name: 'wist', exact: true })).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await page.getByRole('option', { name: 'wist', exact: true }).click();
  await expect(note(page)).toContainText('Moods: [[wist]],');
  await letItSave(page);

  // The Journal lens lists the entries with their moods.
  await page.goto('/browse/journal');
  await expect(page.getByRole('list', { name: 'Notes' })).toContainText('wist');
});
