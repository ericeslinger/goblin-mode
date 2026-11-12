import type { Page } from '@playwright/test';
import { expect, signInAs, test, openMore } from '../src/fixtures';
import { OWNER } from '../src/personas';

/**
 * The owner's note key on localhost (note encryption step 2): the
 * Worker's derivation over the development master, as the e2e static
 * server's `/api/note-key` and the functions emulator's stand-in give it.
 */
const OWNER_NOTE_KEY = { v: 1, key: 'JUkfqWWWRviyLQOyRmd3TNdNb/4lN1AG39AXnh86vb4=' };
const noteKeyOnDevice = (page: Page) =>
  page.evaluate((uid) => localStorage.getItem(`goblin.noteKey.${uid}`), OWNER.uid);

test('signing in shows the account and build in Settings', async ({ page }) => {
  await signInAs(page, OWNER);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  // Signed in and online, the app fetches its note key and keeps it here.
  await expect.poll(() => noteKeyOnDevice(page)).toBe(JSON.stringify(OWNER_NOTE_KEY));

  await (await openMore(page)).getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText(`Signed in as ${OWNER.email}`)).toBeVisible();
  await expect(page.getByText('e2e · e2e')).toBeVisible();
  // Check for updates asks the worker to look now (Eric, 2026-11-07).
  // Deep in a long page the phone emulation's hit test lands beside the
  // button, so it is pressed from the keyboard, as a screen-reader user would.
  const check = page.getByRole('button', { name: 'Check for updates' });
  await check.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').last()).toContainText(
    /latest version|not managed here|newer version|Could not check/,
    { timeout: 15_000 },
  );

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Not signed in.')).toBeVisible();
  // Signing out forgets it.
  await expect.poll(() => noteKeyOnDevice(page)).toBeNull();
});
