import { expect, test } from '../src/fixtures';

// A boot that lost a script reloads once (index.html, 2026-11-17).
// Chromium now and then aborted one of the first chunks on a page the
// service worker served, and the page stayed blank. Here the first
// chunk request of a fresh page is aborted the same way, before any
// worker is in the way, and the page must come up all the same.
test('a first load that loses a chunk reloads and comes up', async ({ page }) => {
  let lost = '';
  let askedAgain = false;
  await page.route(/\/chunk-[^/]+\.js$/, (route) => {
    const url = route.request().url();
    if (!lost) {
      lost = url;
      return route.abort('aborted');
    }
    if (url === lost) askedAgain = true;
    return route.continue();
  });
  await page.goto('/dev-sign-in');
  await expect(page.getByRole('heading', { name: 'Dev sign-in' })).toBeVisible();
  // It came up by loading again, not by doing without the chunk.
  expect(askedAgain).toBe(true);
});
