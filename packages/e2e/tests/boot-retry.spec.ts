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

// It retries once, not in a spin (review of #325): with every chunk
// lost the page is asked for twice, and not a third time while the
// minute's mark holds.
test('a load that keeps losing its chunks is retried once, not in a loop', async ({ page }) => {
  let pages = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest()) pages += 1;
  });
  await page.route(/\/chunk-[^/]+\.js$/, (route) => route.abort('aborted'));
  await page.goto('/dev-sign-in');
  await expect.poll(() => pages).toBe(2);
  // Long enough for a third load to have shown, had one been coming.
  await page.waitForTimeout(2000);
  expect(pages).toBe(2);
  await expect(page.getByRole('heading', { name: 'Dev sign-in' })).toHaveCount(0);
});
