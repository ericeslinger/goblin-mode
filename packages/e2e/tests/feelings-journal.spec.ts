import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  FIRESTORE_EMULATOR,
  expect,
  letItSave,
  openMore,
  signInAs,
  switchModulesOn,
  test,
  typeLines,
  openSettings,
} from '../src/fixtures';
import { OWNER } from '../src/personas';

// The feelings journal (#40): a template from Settings with three daily
// reminders that each open a new entry; moods on the Moods line are
// concepts of type mood, offered again the next time. Since step 7 of
// #324 (2026-11-22), with Habits on, three habits that open an entry
// instead of the reminders; and a journal made with Habits off is
// offered its move on the Habits screen.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

const MEALS = ['breakfast', 'lunch', 'dinner'].map((m) => `Feelings journal: ${m}`);

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

/** The owner's documents in a collection as stored, read as admin, by id. */
async function storedIds(collection: string): Promise<string[]> {
  const res = await fetch(
    `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}/${collection}`,
    { headers: { authorization: 'Bearer owner' } },
  );
  const { documents = [] } = (await res.json()) as { documents?: { name: string }[] };
  return documents.map((d) => d.name.split('/').pop()!).sort();
}

const habitsOnRightNow = (page: Page) => page.getByRole('region', { name: 'Habits' });
const card = (page: Page, name: string) =>
  page.locator('app-habit-card').filter({ has: page.getByRole('heading', { name, exact: true }) });

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

test('a feelings journal with Habits on: three habits that open an entry', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAs(page, OWNER);
  await switchModulesOn(page, 'Habits');
  await openSettings(page, 'Templates');
  await page.getByRole('button', { name: 'Add a feelings journal' }).click();
  await expect(page.getByRole('region', { name: 'Template' })).toBeVisible();
  const templateUrl = page.url();
  await letItSave(page);

  // Right Now: three habits at the journal's times, and no reminders.
  await page.goto('/right-now');
  const section = habitsOnRightNow(page);
  await expect(section.getByRole('listitem')).toHaveText([
    /^Feelings journal: breakfast\s*08:00/,
    /^Feelings journal: lunch\s*12:30/,
    /^Feelings journal: dinner\s*18:30/,
  ]);
  for (const name of MEALS) await expect(page.getByRole('link', { name })).toHaveCount(0);
  expect(await storedIds('reminders')).toEqual([]);
  await noSeriousViolations(page);

  // A tick opens a new entry from the template, with its Moods line.
  await section.getByRole('button', { name: 'Done: Feelings journal: breakfast' }).click();
  await expect(page).toHaveURL(/\/n\/[A-Za-z0-9]+$/);
  expect(page.url()).not.toBe(templateUrl);
  await expect(page.getByRole('region', { name: 'Template' })).toHaveCount(0);
  await expect(note(page)).toContainText('Moods:');
  await expect(note(page)).toContainText('What helped');
  const entryId = page.url().split('/').pop()!;
  await letItSave(page);

  // Done on the Habits screen, with the entry a link away.
  await page.goto('/habits');
  const breakfast = card(page, 'Feelings journal: breakfast');
  await expect(
    breakfast.getByRole('button', { name: 'Done today: Feelings journal: breakfast' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(breakfast.getByRole('link', { name: 'Open the entry' })).toHaveAttribute(
    'href',
    `/n/${entryId}`,
  );
  // Nothing to offer: this journal never had reminders.
  await expect(page.getByRole('region', { name: 'Feelings journal reminders' })).toHaveCount(0);
  await noSeriousViolations(page);
});

test('a feelings journal made with Habits off is offered its move to habits', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAs(page, OWNER);
  // Habits off: the journal's reminders, as before.
  await openSettings(page, 'Templates');
  await page.getByRole('button', { name: 'Add a feelings journal' }).click();
  await expect(page.getByRole('region', { name: 'Template' })).toBeVisible();
  await letItSave(page);
  await page.goto('/right-now');
  for (const name of MEALS) await expect(page.getByRole('link', { name })).toBeVisible();
  expect(await storedIds('reminders')).toHaveLength(3);

  // Habits on: the Habits screen offers the move, never makes it alone.
  await switchModulesOn(page, 'Habits');
  await page.goto('/habits');
  const offer = page.getByRole('region', { name: 'Feelings journal reminders' });
  await expect(offer).toContainText('Your feelings journal has three reminders. Make them habits?');
  await expect(offer).toContainText('08:00 Feelings journal: breakfast');
  // What changes, said in the offer (review of #333, 2026-11-22).
  await expect(offer).toContainText(
    'The nudge opens Right Now, where ticking the habit opens a new entry',
  );
  expect(await storedIds('habits')).toEqual([]);
  await noSeriousViolations(page);
  await offer.getByRole('button', { name: 'Make them habits' }).click();
  for (const name of MEALS) await expect(card(page, name)).toBeVisible();
  await expect(offer).toHaveCount(0);
  await letItSave(page);

  // The reminders are gone, stored and on Right Now; the habits are there.
  // Each goes once its habit is heard back (review of #333, 2026-11-22).
  await expect.poll(() => storedIds('reminders')).toEqual([]);
  const habits = await storedIds('habits');
  expect(habits).toHaveLength(3);
  expect(habits.every((id) => id.startsWith('journal-'))).toBe(true);
  await page.goto('/right-now');
  const section = habitsOnRightNow(page);
  // Each is listed or, done today as a reminder already, in the line under them.
  for (const name of MEALS) {
    await expect(section).toContainText(name);
    await expect(page.getByRole('link', { name })).toHaveCount(0);
  }
  await page.reload();
  await expect(section).toContainText(MEALS[0]);
  for (const name of MEALS) await expect(page.getByRole('link', { name })).toHaveCount(0);
  await page.goto('/habits');
  await expect(page.getByRole('region', { name: 'Feelings journal reminders' })).toHaveCount(0);
});
