import AxeBuilder from '@axe-core/playwright';
import { type Page, devices } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { serveEpisodes, serveProxy } from '../src/episodes';
import { expect, letItSave, prepPage, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Podcasts (#245, step 1 of #244): a module of its own, out of the
// Reader. Add a podcast by its address (the server's discovery, #174),
// its episodes in Latest, new until heard (Eric, 2026-11-10), an
// episode's page that reads its notes and nothing else, the player
// (#179) and the place synced across devices, downloads for offline
// playback (#180), and a show moved to the Reader and back. The
// player's and the downloads' journeys came from reader.spec.ts.

const FEED = 'https://feeds.invalid/pod.xml';
const SHOW = 'Kiln hour (fixture)';

const axe = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
};

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Podcasts screens' });
const episodes = (page: Page) => page.getByRole('list', { name: 'Episodes' }).getByRole('listitem');

/** Podcasts on in Settings, then the fixture podcast added by its address and looked at. */
async function addThePodcast(page: Page, { podcastsOnly = false } = {}): Promise<void> {
  await page.goto('/settings');
  // Podcasts alone was switched on by the journey already: only wait
  // for Settings to read it (a click before then would switch it off).
  if (!podcastsOnly) await page.getByRole('switch', { name: 'Reader' }).check();
  await expect(page.getByRole('switch', { name: 'Podcasts' })).toBeChecked();
  await letItSave(page);
  await page.goto('/podcasts/add');
  await page.getByRole('textbox', { name: "The show's feed, or its site" }).fill(FEED);
  // The button waits for the feeds to be read, as the Reader's does.
  await expect(page.getByRole('button', { name: 'Find the feed' })).toBeEnabled();
  await page.getByRole('button', { name: 'Find the feed' }).click();
  const found = page.getByRole('radiogroup', { name: 'Feeds found' });
  await expect(found).toContainText(SHOW, { timeout: 15_000 });
  await expect(found).toContainText('Found its feed · 2 episodes');
  await page.getByRole('combobox', { name: 'Folder' }).fill('Listening');
  await page.getByRole('button', { name: `Follow ${SHOW}` }).click();
  await expect(page.getByRole('status')).toContainText(`Following ${SHOW}.`);
  await letItSave(page);
  await page.goto('/podcasts/shows');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('2 new articles', { timeout: 30_000 });
}

test('add a podcast, its episodes in Latest, new until heard; move it to the Reader and back', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await serveEpisodes(page);
  await signInAs(page, OWNER);
  const call = await connectClaude(page);

  // The module follows the Reader until switched itself: both off, no tile.
  await page.goto('/home');
  await expect(page.getByRole('link', { name: /^Podcasts/ })).toHaveCount(0);
  await page.goto('/settings');
  await expect(page.getByRole('switch', { name: 'Reader' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Podcasts' })).not.toBeChecked();

  // Switched on alone, with the Reader off; its tile on Home.
  await page.getByRole('switch', { name: 'Podcasts' }).check();
  await letItSave(page);
  await page.goto('/home');
  await page
    .getByRole('navigation', { name: 'Modules' })
    .getByRole('link', { name: /^Podcasts/ })
    .click();
  await expect(page).toHaveURL(/\/podcasts$/);
  await expect(page.getByRole('heading', { name: 'Podcasts', level: 1 })).toBeVisible();
  await expect(tabs(page).getByRole('link')).toHaveText([/^Latest/, 'Shows']);
  await expect(page.getByText('No shows yet.')).toBeVisible();
  await axe(page);

  // Add a podcast: the switch for the queue is off until switched on.
  await page.getByRole('link', { name: 'Add a podcast' }).first().click();
  await expect(page.getByRole('heading', { name: 'Add a podcast', level: 1 })).toBeVisible();
  await expect(page.getByRole('switch', { name: /New episodes join the queue/ })).not.toBeChecked();
  await axe(page);
  await addThePodcast(page, { podcastsOnly: true });
  const shows = page.getByRole('list', { name: 'Shows' });
  await expect(shows.getByRole('listitem')).toHaveCount(1);
  await expect(shows).toContainText(SHOW);
  await expect(shows).toContainText('2 episodes · 2 new');
  await axe(page);
  // The assistant tells its episodes apart (#245).
  const listed = (await call('list_feed_items', { podcasts: true })) as {
    title: string;
    podcast?: boolean;
  }[];
  expect(listed.map((i) => [i.title, i.podcast])).toEqual([
    ['Reduction firing', true],
    ['Wedging clay', true],
  ]);
  expect(await call('list_feed_items', { podcasts: false })).toEqual([]);

  // Latest: the newest first, new, with the show, the age and the length.
  await tabs(page)
    .getByRole('link', { name: /^Latest/ })
    .click();
  await expect(tabs(page).getByRole('link', { name: /^Latest/ })).toContainText('2');
  await expect(episodes(page)).toHaveCount(2);
  await expect(episodes(page).first()).toContainText('Reduction firing');
  await expect(episodes(page).first()).toContainText(`New · ${SHOW}`);
  await expect(episodes(page).first()).toContainText('42 min');
  await expect(episodes(page).nth(1)).toContainText('1 h 05 min');
  await axe(page);

  // Its page reads the notes, and nothing else: still New, notes read.
  await episodes(page)
    .getByRole('link', { name: /Reduction firing/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Reduction firing', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Show notes' })).toBeVisible();
  await expect(page.getByText('Why the flame goes orange')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as heard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'File in the garden' })).toBeVisible();
  await axe(page);
  await letItSave(page);
  await page.getByRole('link', { name: 'Latest', exact: true }).click();
  await expect(episodes(page).first()).toContainText('New, notes read');

  // Played from its row: Pause and the time left while it plays, then Started.
  await page.getByRole('button', { name: 'Play Reduction firing' }).click();
  const bar = page.getByRole('complementary', { name: 'Now playing' });
  await expect(bar).toContainText('Reduction firing');
  const pause = page.getByRole('button', { name: 'Pause Reduction firing' });
  await expect(pause).toBeVisible();
  await expect(episodes(page).first()).toContainText('left');
  await expect(bar).toContainText(/0:0[1-4] \//, { timeout: 10_000 });
  await pause.click();
  // Its row may have left the New list already, being Started: the
  // player's own button says it is paused.
  await expect(bar.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await letItSave(page);
  await page.getByRole('button', { name: /^Started/ }).click();
  await expect(episodes(page)).toHaveCount(1);
  await expect(episodes(page).first()).toContainText('Started, notes read');
  await page.getByRole('button', { name: /^New/ }).click();
  await expect(episodes(page)).toHaveCount(1);
  await expect(episodes(page).first()).toContainText('Wedging clay');
  await axe(page);

  // Misfiled: More on the show moves it to the Reader, where its items are articles.
  await tabs(page).getByRole('link', { name: 'Shows' }).click();
  await page.getByRole('button', { name: `More for ${SHOW}` }).click();
  await page.getByRole('button', { name: /Move to the Reader/ }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `${SHOW} is in the Reader now.` }),
  ).toBeVisible();
  await expect(shows.getByRole('listitem')).toHaveCount(0);
  await letItSave(page);
  expect(await call('list_feed_items', { podcasts: true, includeRead: true })).toEqual([]);
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Reader' }).check();
  await letItSave(page);
  await page.goto('/reader');
  const readerTabs = page.getByRole('navigation', { name: 'Reader screens' });
  // No Podcasts shelf in the Reader (#245).
  await expect(readerTabs.getByRole('link')).toHaveText([/^All/, 'Saved', 'Folders']);
  await expect(page.getByRole('list', { name: 'Articles' })).toContainText('Wedging clay');

  // And back from Manage feeds.
  await page.getByRole('link', { name: 'Manage feeds' }).click();
  await page
    .getByRole('list', { name: 'Folders' })
    .locator('summary', { hasText: 'Listening' })
    .click();
  await page.getByRole('button', { name: `Move to Podcasts: ${SHOW}` }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `${SHOW} is in Podcasts now.` }),
  ).toBeVisible();
  await letItSave(page);
  await page.goto('/reader');
  await expect(page.getByRole('list', { name: 'Articles' })).not.toContainText('Wedging clay');
  await page.goto('/podcasts/shows');
  await expect(shows.getByRole('listitem')).toHaveCount(1);
  await page.goto('/podcasts');
  await expect(episodes(page).first()).toContainText('Wedging clay');
});

// The player (#179): the podcast added and looked at, its first
// episode played and paused on its page, the place kept across a
// reload and shown on another device under Started, then heard to the
// end, which marks it heard.
test('play an episode, keep the place across a reload and on another device', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await serveEpisodes(page);
  await signInAs(page, OWNER);
  await addThePodcast(page);
  await page.goto('/podcasts');
  await expect(tabs(page).getByRole('link', { name: /^Latest/ })).toContainText('2');
  await page.getByRole('button', { name: /^Started/ }).click();
  await expect(episodes(page)).toHaveCount(0);

  // The episode's page: play, then pause past the first second.
  await page.getByRole('button', { name: /^New/ }).click();
  await episodes(page)
    .getByRole('link', { name: /Reduction firing/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Reduction firing', level: 1 })).toBeVisible();
  const player = page.getByRole('region', { name: 'Player' });
  const slider = player.getByRole('slider', { name: 'Position' });
  await expect(slider).toHaveAttribute('aria-valuetext', '0:00 of 42:10');
  await expect(page.getByRole('complementary', { name: 'Now playing' })).toHaveCount(0);
  await axe(page);
  await player.getByRole('button', { name: 'Play' }).click();
  // The audio's own length replaces the feed's once it loads.
  await expect(slider).toHaveAttribute('aria-valuetext', /^0:0[1-4] of 0:06$/, {
    timeout: 10_000,
  });
  await player.getByRole('button', { name: 'Pause' }).click();
  await expect(player.getByRole('button', { name: 'Play' })).toBeVisible();
  const kept = (await slider.getAttribute('aria-valuetext'))!.split(' of ')[0];
  expect(kept).not.toBe('0:00');
  await expect(page.locator('article .head .state')).toHaveText('Started, notes read');
  await letItSave(page);

  // A reload finds it where it was, paused.
  await page.reload();
  await expect(slider).toHaveAttribute('aria-valuetext', `${kept} of 42:10`);
  await expect(player.getByRole('button', { name: 'Play' })).toBeVisible();
  await page.goto('/podcasts');
  const bar = page.getByRole('complementary', { name: 'Now playing' });
  await expect(bar).toContainText('Reduction firing');
  await expect(bar).toContainText(`${kept} / 42:10`);
  await page.getByRole('button', { name: /^Started/ }).click();
  await expect(episodes(page)).toHaveCount(1);
  await expect(episodes(page).first()).toContainText('Reduction firing');
  await expect(episodes(page).first()).toContainText('min left');
  await axe(page);

  // Another device sees the place, and its episode page starts there.
  const other = await browser.newContext({ ...devices['Pixel 7'] });
  const second = await other.newPage();
  await prepPage(second);
  await serveEpisodes(second);
  await signInAs(second, OWNER, { reset: false });
  await second.goto('/podcasts');
  await second.getByRole('button', { name: /^Started/ }).click();
  await expect(episodes(second)).toHaveCount(1);
  await episodes(second)
    .getByRole('link', { name: /Reduction firing/ })
    .click();
  await expect(
    second.getByRole('region', { name: 'Player' }).getByRole('slider', { name: 'Position' }),
  ).toHaveAttribute('aria-valuetext', `${kept} of 42:10`);

  // Heard to the end from the mini-player: heard, here and there.
  await bar.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(bar.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(episodes(page)).toHaveCount(0, { timeout: 15_000 });
  await expect(bar.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(tabs(page).getByRole('link', { name: /^Latest/ })).toContainText('1');
  await expect(second.getByRole('button', { name: 'Mark as new' })).toBeVisible();
  await expect(second.getByRole('region', { name: 'Player' })).toContainText('Played to the end.');
  await other.close();
});

// Downloads (#180): the fixture episode downloaded through the proxy's
// stand-in into the episodes cache, listed with its size, then played
// with the browser offline, the service worker answering the player's
// ranges from the cache, then removed.
test('download an episode, play it offline, remove it', async ({ page }) => {
  test.setTimeout(120_000);
  await serveEpisodes(page);
  const asked = await serveProxy(page);
  await signInAs(page, OWNER);
  // The app registers its worker once settled (at most 30 s); a reload
  // puts the page under it, as an installed app always is.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 })
    .toBe(true);
  await addThePodcast(page);
  await page.goto('/settings');
  await expect(
    page.getByRole('combobox', { name: 'Downloaded episodes kept on this device, at most' }),
  ).toHaveValue('500');
  await expect(
    page.getByRole('switch', { name: 'Download new episodes on their own only on Wi-Fi' }),
  ).toBeChecked();

  // Download from the episode's page: through the proxy, with the ID token.
  await page.goto('/podcasts');
  await episodes(page)
    .getByRole('link', { name: /Reduction firing/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Reduction firing', level: 1 })).toBeVisible();
  const player = page.getByRole('region', { name: 'Player' });
  // Download is the header's icon (#221); downloaded, the same place offers Remove download.
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(player).toContainText('Downloaded, 47 KB', { timeout: 15_000 });
  await expect(page.locator('article .head .meta')).toContainText('Downloaded ·');
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatch(/^Bearer \S+$/);
  await expect(page.getByRole('button', { name: 'Remove download' })).toBeVisible();
  await axe(page);

  // The Downloads list, from Podcasts' header: its size, the total against the cap.
  await page.getByRole('link', { name: 'Latest', exact: true }).click();
  await expect(episodes(page).first()).toContainText('downloaded');
  await page.getByRole('link', { name: 'Downloads' }).click();
  await expect(page.getByRole('heading', { name: 'Downloads', level: 1 })).toBeVisible();
  const list = page.getByRole('list', { name: 'Downloads' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('Reduction firing');
  await expect(list).toContainText(`${SHOW} · 47 KB`);
  await expect(page.getByRole('status')).toHaveText('1 episode, 47 KB of 500 MB');
  await axe(page);

  // Offline: the page and the player go on, the file from the cache.
  await page.context().setOffline(true);
  await list.getByRole('link', { name: /Reduction firing/ }).click();
  await expect(page).toHaveURL(/\/podcasts\/e\//);
  await expect(page.getByRole('heading', { name: 'Reduction firing', level: 1 })).toBeVisible();
  const slider = player.getByRole('slider', { name: 'Position' });
  await player.getByRole('button', { name: 'Play' }).click();
  await expect(slider).toHaveAttribute('aria-valuetext', /^0:0[1-4] of 0:06$/, {
    timeout: 10_000,
  });
  await player.getByRole('button', { name: 'Pause' }).click();
  // Nothing reached the proxy's stand-in: the service worker answered
  // the player's ranges from the cache.
  expect(asked).toHaveLength(1);
  await page.context().setOffline(false);

  // Removed: gone from the list and the cache.
  await page.goto('/reader/downloads');
  await list.getByRole('button', { name: 'Remove download: Reduction firing' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByText('Nothing downloaded yet.')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('0 episodes, 0 MB of 500 MB');
  const cached = await page.evaluate(async () =>
    (await (await caches.open('mossgoblin-episodes')).keys()).map((r) => r.url),
  );
  expect(cached).toEqual([]);
});
