import { type Page, devices } from '@playwright/test';
import { expect, letItSave, prepPage, signInAs, test, typeLines, openMore } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Every note has its own URL, /n/<id> (#27): back and forward move
// between notes, and a link opens the note from anywhere.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

/** The id in a /n/<id> URL. */
const idIn = (url: string) => /\/n\/([^/?#]+)/.exec(url)?.[1];

test('back and forward move between notes', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['The first thought']);
  await letItSave(page);

  // New: the first note's history entry becomes its own URL.
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page).toHaveURL(/\/$/);
  await typeLines(page, ['The second thought']);
  await letItSave(page);

  await (await openMore(page)).getByRole('link', { name: 'Browse' }).click();
  await page.getByRole('list', { name: 'Notes' }).getByRole('link', { name: /first/ }).click();
  await expect(page).toHaveURL(/\/n\/\w+$/);
  await expect(note(page)).toContainText('The first thought');

  await page.goBack();
  await expect(page).toHaveURL(/\/browse$/);
  await page.goBack();
  await expect(note(page)).toContainText('The second thought');
  await page.goBack();
  await expect(page).toHaveURL(/\/n\/\w+$/);
  await expect(note(page)).toContainText('The first thought');

  await page.goForward();
  await expect(note(page)).toContainText('The second thought');
});

test('a note link opens that note on another device', async ({ page, browser }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Linked from a chat']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  await page.goBack();
  const id = idIn(page.url());
  expect(id).toBeTruthy();

  const other = await browser.newContext({ ...devices['Pixel 7'] });
  const second = await other.newPage();
  await prepPage(second);
  await signInAs(second, OWNER, { reset: false });
  await second.goto(`/n/${id}`);
  // A cold second device signs in and waits for its first snapshot.
  await expect(note(second)).toContainText('Linked from a chat', { timeout: 15_000 });
  await other.close();
});

test('a note link the device has not got yet waits, read-only', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/n/not-here-yet');
  await expect(page.getByRole('status').filter({ hasText: 'reached this device' })).toBeVisible();
  await expect(note(page)).toHaveAttribute('contenteditable', 'false');
});

test('note links work offline', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Read on the train']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  await page.goBack();
  const id = idIn(page.url());

  // Let the service worker take over, so the app shell is cached.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(note(page)).toContainText('Read on the train');

  await page.context().setOffline(true);
  // Followed in the app...
  await page.goto('/');
  await (await openMore(page)).getByRole('link', { name: 'Browse' }).click();
  await page.getByRole('list', { name: 'Notes' }).getByRole('link', { name: /train/ }).click();
  await expect(note(page)).toContainText('Read on the train');
  // ...and opened cold from the address bar.
  await page.goto('/browse');
  await page.goto(`/n/${id}`);
  await expect(note(page)).toContainText('Read on the train');
  await page.context().setOffline(false);
});
