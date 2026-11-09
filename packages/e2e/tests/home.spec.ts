import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Home (#219, step 1 of #216): the box to write in, Right Now, and a
// tile per place, a module that is off having none. The box opens the
// editor at /, so a line typed there is a note like any other. Start on
// picks where a cold open of / lands; a new note until chosen.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });
const tiles = (page: Page) => page.getByRole('navigation', { name: 'Modules' });

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test('Home shows the places, its box writes a note, and Start on lands there', async ({ page }) => {
  await signInAs(page, OWNER);
  // The launch bar's leaf, not a reload: a page loaded again a moment
  // after sign-in starts a second Firestore client on an empty cache,
  // whose notes wait on the server's first answer (see below).
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', { name: 'Mossgoblin', level: 1 })).toBeVisible();
  for (const name of [/^Notes/, /^Reading queue/, /^Assistants/, /^Map/]) {
    await expect(tiles(page).getByRole('link', { name })).toBeVisible();
  }
  // Kitchen and the Reader start off: no tile.
  await expect(tiles(page).getByRole('link', { name: /^Kitchen/ })).toHaveCount(0);
  await expect(tiles(page).getByRole('link', { name: /^Reader/ })).toHaveCount(0);
  await expectNoSeriousViolations(page);

  // The box opens the editor with the cursor in it.
  await page.getByRole('link', { name: 'Plant a thought' }).click();
  await expect(note(page)).toBeFocused();
  await typeLines(page, ['Order a kiln shelf']);
  await letItSave(page);

  // The leaf goes Home; the note is counted, and is in Browse. On a new
  // account the notes are not known until the server's first answer
  // (an empty cache raises no snapshot), and until then the line waits
  // as the pending draft, written the moment they are: so this waits
  // longer than an expectation's default.
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(tiles(page).getByRole('link', { name: /^Notes/ })).toContainText('1 · 1 today', {
    timeout: 20_000,
  });
  await tiles(page)
    .getByRole('link', { name: /^Notes/ })
    .click();
  await expect(page.getByRole('list', { name: 'Notes' })).toContainText('Order a kiln shelf');

  // A module switched on gets its tile.
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: 'Kitchen' }).check();
  await letItSave(page);
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(tiles(page).getByRole('link', { name: /^Kitchen/ })).toContainText(
    'Tonight: nothing planned',
  );

  // Start on Home: a cold open of / lands there; a note's link does not.
  await page.goto('/settings');
  await expect(page.getByRole('radio', { name: /^A new note/ })).toBeChecked();
  await page.getByRole('radio', { name: /^Home/ }).check();
  await letItSave(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', { name: 'Mossgoblin', level: 1 })).toBeVisible();
  await page.goto('/n/context');
  await expect(note(page)).toBeVisible();

  // Back to a new note: / is the editor again.
  await page.goto('/settings');
  await page.getByRole('radio', { name: /^A new note/ }).check();
  await letItSave(page);
  await page.goto('/');
  await expect(note(page)).toBeVisible();
  await expect(page).not.toHaveURL(/\/home$/);
});
