import { devices } from '@playwright/test';
import { expect, letItSave, prepPage, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

const note = (page: import('@playwright/test').Page) =>
  page.getByRole('textbox', { name: 'New note' });

/** An empty note shows its placeholder (part of the editor's text). */
const expectEmpty = (page: import('@playwright/test').Page) =>
  expect(note(page).getByText('Plant a thought')).toBeVisible();

test('a note saves as it is typed and is there after a reload', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Groceries', 'eggs and milk']);
  await letItSave(page);

  // Back within five minutes: the same note reopens.
  await page.reload();
  await expect(note(page)).toContainText('Groceries');
  await expect(note(page)).toContainText('eggs and milk');
});

test('after five minutes away a fresh note opens, and Previous note brings the old one back', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['An old thought']);
  await letItSave(page);

  // Hide the app, then pretend it was hidden six minutes ago.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    const seen = JSON.parse(localStorage.getItem('goblin.lastSeen')!);
    seen.hiddenAt -= 6 * 60_000;
    localStorage.setItem('goblin.lastSeen', JSON.stringify(seen));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expectEmpty(page);

  await page.getByRole('button', { name: 'Previous note' }).click();
  await page
    .getByRole('list', { name: 'Previous notes' })
    .getByRole('button', { name: 'An old thought' })
    .click();
  await expect(note(page)).toHaveText('An old thought');
});

test('typing offline reaches another device once back online', async ({ page, browser }) => {
  await signInAs(page, OWNER);
  await page.context().setOffline(true);
  await expect(page.getByRole('status')).toHaveText('offline');
  await typeLines(page, ['Written on the train']);
  await letItSave(page);
  await page.context().setOffline(false);
  await expect(page.getByRole('status')).toHaveText('synced');

  const other = await browser.newContext({ ...devices['Pixel 7'] });
  const second = await other.newPage();
  await prepPage(second);
  await signInAs(second, OWNER, { reset: false });
  await second.goto('/browse');
  await expect(second.getByRole('list', { name: 'Notes' })).toContainText('Written on the train');
  await other.close();
});

test('search finds a note and opens it', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Project Hotswap', 'sync with Vikas on Friday']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  await expectEmpty(page);
  await typeLines(page, ['Something else']);
  await letItSave(page);

  await page.getByRole('link', { name: 'Browse' }).click();
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('hotswap vikas');
  const results = page.getByRole('list', { name: 'Notes' }).getByRole('link');
  await expect(results).toHaveCount(1);
  await results.first().click();
  await expect(note(page)).toContainText('Project Hotswap');
});

test('wide screens show all notes beside the open one', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Wide screen note']);
  await letItSave(page);
  await page.setViewportSize({ width: 1200, height: 800 });
  const pane = page.getByRole('complementary', { name: 'All notes' });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('link', { name: /Wide screen note/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByRole('link', { name: 'Browse' })).toBeHidden();
});
