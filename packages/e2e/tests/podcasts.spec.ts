import AxeBuilder from '@axe-core/playwright';
import { type Page, devices } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { SHOW_ART, serveEpisodes, serveProxy } from '../src/episodes';
import { FIRESTORE_EMULATOR, expect, letItSave, prepPage, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Podcasts (#245, step 1 of #244): a module of its own, out of the
// Reader. Add a podcast by its address (the server's discovery, #174),
// its episodes in Latest, new until heard (Eric, 2026-11-10), an
// episode's page that reads its notes and nothing else, the player
// (#179) and the place synced across devices, downloads for offline
// playback (#180), and a show moved to the Reader and back. The
// player's and the downloads' journeys came from reader.spec.ts. Step 2
// (#246): the Shows grid with the feeds' artwork, its folder chips, the
// shows by folder, and one show's page with its filters, sort, search
// and More. Step 3 (#249): the listening queue, added to from Latest
// and an episode's page, arranged by its More and its grip's arrows,
// played through, and appended to by the fetcher for a show whose new
// episodes join it.

const FEED = 'https://feeds.invalid/pod.xml';
const SHOW = 'Kiln hour (fixture)';
/** A second show (#246), newer than the first, in no folder, with no artwork. */
const FEED2 = 'https://feeds.invalid/glaze.xml';
const SHOW2 = 'Glaze lab (fixture)';
/** A third show (#249) whose second look finds a new episode, Trimming feet. */
const FEED3 = 'https://feeds.invalid/wheel.xml';
const SHOW3 = 'Wheel talk (fixture)';

const axe = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
};

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Podcasts screens' });
const episodes = (page: Page) => page.getByRole('list', { name: 'Episodes' }).getByRole('listitem');
/** The Shows grid (#246): a square per show, each a link named for it. */
const grid = (page: Page) => page.getByRole('list', { name: 'Shows' });

/** A show followed from Add a podcast by its feed's address, in a folder when given. */
async function follow(page: Page, feed: string, show: string, folder?: string): Promise<void> {
  await page.goto('/podcasts/add');
  await page.getByRole('textbox', { name: "The show's feed, or its site" }).fill(feed);
  // The button waits for the feeds to be read, as the Reader's does.
  await expect(page.getByRole('button', { name: 'Find the feed' })).toBeEnabled();
  await page.getByRole('button', { name: 'Find the feed' }).click();
  const found = page.getByRole('radiogroup', { name: 'Feeds found' });
  await expect(found).toContainText(show, { timeout: 15_000 });
  await expect(found).toContainText('Found its feed · 2 episodes');
  if (folder) await page.getByRole('combobox', { name: 'Folder' }).fill(folder);
  await page.getByRole('button', { name: `Follow ${show}` }).click();
  await expect(page.getByRole('status')).toContainText(`Following ${show}.`);
  await letItSave(page);
}

/**
 * Podcasts on in Settings, then the fixture podcast added by its
 * address in Listening (and the second show, in no folder, with
 * `second`), and looked at.
 */
async function addThePodcast(
  page: Page,
  { podcastsOnly = false, second = false } = {},
): Promise<void> {
  await page.goto('/settings');
  // Podcasts alone was switched on by the journey already: only wait
  // for Settings to read it (a click before then would switch it off).
  if (!podcastsOnly) await page.getByRole('switch', { name: 'Reader' }).check();
  await expect(page.getByRole('switch', { name: 'Podcasts' })).toBeChecked();
  await letItSave(page);
  await follow(page, FEED, SHOW, 'Listening');
  if (second) await follow(page, FEED2, SHOW2);
  await page.goto('/podcasts/shows');
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText(`${second ? 4 : 2} new articles`, {
    timeout: 30_000,
  });
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
  await expect(tabs(page).getByRole('link')).toHaveText([/^Latest/, 'Shows', /^Queue/]);
  await expect(page.getByText('No shows yet.')).toBeVisible();
  await axe(page);

  // Add a podcast: the switch for the queue is off until switched on.
  await page.getByRole('link', { name: 'Add a podcast' }).first().click();
  await expect(page.getByRole('heading', { name: 'Add a podcast', level: 1 })).toBeVisible();
  await expect(page.getByRole('switch', { name: /New episodes join the queue/ })).not.toBeChecked();
  await axe(page);
  await addThePodcast(page, { podcastsOnly: true });
  const shows = grid(page);
  await expect(shows.getByRole('listitem')).toHaveCount(1);
  await expect(shows.getByRole('link')).toHaveAccessibleName(`${SHOW}, 2 unheard`);
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

  // Misfiled: More on the show's page (#246) moves it to the Reader,
  // where its items are articles.
  await tabs(page).getByRole('link', { name: 'Shows' }).click();
  await shows.getByRole('link', { name: SHOW }).click();
  await expect(page.getByRole('heading', { name: SHOW, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: `More for ${SHOW}` }).click();
  await page
    .getByRole('dialog', { name: `More for ${SHOW}` })
    .getByRole('button', { name: /Move to the Reader/ })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: `${SHOW} is in the Reader now.` }),
  ).toBeVisible();
  await letItSave(page);
  await page.goto('/podcasts/shows');
  await expect(page.getByText('No shows yet.')).toBeVisible();
  await expect(shows.getByRole('listitem')).toHaveCount(0);
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

// Shows (#246, step 2 of #244): two shows, newest episode first, each
// a square with its unheard count, Kiln hour's the feed's own artwork
// and Glaze lab's name on a tinted square; Listening's chip filters the
// grid; the folder view lists Listening with its strip; Kiln hour's
// page keeps its queue switch, sorts oldest first, finds an episode by
// its notes, and Mark all as heard clears its count in the grid.
test('the Shows grid, by folder, and one show’s page', async ({ page }) => {
  test.setTimeout(120_000);
  await serveEpisodes(page);
  await signInAs(page, OWNER);
  await addThePodcast(page, { second: true });

  // The grid: Glaze lab's newest episode is newer, so it comes first.
  const squares = grid(page).getByRole('link');
  await expect(squares).toHaveCount(2);
  await expect(squares.nth(0)).toHaveAccessibleName(`${SHOW2}, 2 unheard`);
  await expect(squares.nth(1)).toHaveAccessibleName(`${SHOW}, 2 unheard`);
  await expect(page.getByText('2 shows, newest episode first')).toBeVisible();
  // Kiln hour's own artwork, served; Glaze lab has none, so its name is drawn.
  await expect(squares.nth(1).locator('img')).toHaveAttribute('src', SHOW_ART);
  await expect(squares.nth(1).locator('img')).toHaveJSProperty('naturalWidth', 1);
  await expect(squares.nth(0).locator('img')).toHaveCount(0);
  await expect(squares.nth(0)).toContainText(SHOW2);
  await axe(page);

  // A folder chip filters it, and All brings both back.
  const chips = page.getByRole('group', { name: 'Folders' });
  await expect(chips.getByRole('button', { name: 'All 2' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await chips.getByRole('button', { name: 'Listening', exact: true }).click();
  await expect(chips.getByRole('button', { name: 'Listening', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(squares).toHaveCount(1);
  await expect(squares.first()).toHaveAccessibleName(`${SHOW}, 2 unheard`);
  await expect(page).toHaveURL(/\/podcasts\/shows\?folder=Listening$/);
  await chips.getByRole('button', { name: 'All 2' }).click();
  await expect(squares).toHaveCount(2);

  // Shows by folder: Listening with its strip, the other show in none, last.
  await page.getByRole('link', { name: 'Shows by folder' }).click();
  await expect(page).toHaveURL(/\/podcasts\/folders$/);
  await expect(page.getByText('2 shows in 1 folder')).toBeVisible();
  const listening = page.getByRole('region', { name: 'Listening' });
  await expect(listening).toContainText('1 show · 2 unheard');
  await expect(
    listening.getByRole('list', { name: 'Shows in Listening' }).getByRole('link'),
  ).toHaveAccessibleName(SHOW);
  const none = page.getByRole('region', { name: 'Not in a folder' });
  await expect(none.getByRole('list', { name: 'Shows in Not in a folder' })).toBeVisible();
  await expect(none.getByRole('link', { name: SHOW2, exact: true })).toBeVisible();
  await axe(page);
  // Its heading opens the grid filtered to it.
  await listening.getByRole('link', { name: /^Listening/ }).click();
  await expect(page).toHaveURL(/\/podcasts\/shows\?folder=Listening$/);
  await expect(squares).toHaveCount(1);

  // One show's page: its name, counts, folder and episodes, newest first.
  await squares.first().click();
  await expect(page.getByRole('heading', { name: SHOW, level: 1 })).toBeVisible();
  await expect(page.getByText('2 episodes · 2 unheard')).toBeVisible();
  await expect(page.getByText('In Listening')).toBeVisible();
  await expect(episodes(page)).toHaveCount(2);
  await expect(episodes(page).first()).toContainText('Reduction firing');
  await axe(page);

  // Its queue switch is stored: off from Add, switched on, on after a reload.
  const queue = page.getByRole('switch', { name: /New episodes join the queue/ });
  await expect(queue).not.toBeChecked();
  await queue.check();
  await expect(queue).toBeChecked();
  await letItSave(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: SHOW, level: 1 })).toBeVisible();
  await expect(queue).toBeChecked();

  // Oldest first, then search within the show, by its notes.
  await page.getByRole('button', { name: 'Newest first' }).click();
  await expect(page.getByRole('button', { name: 'Oldest first' })).toBeVisible();
  await expect(episodes(page).first()).toContainText('Wedging clay');
  await page.getByRole('button', { name: 'Search this show' }).click();
  await page.getByRole('searchbox', { name: `Search ${SHOW}` }).fill('flame orange');
  await expect(episodes(page)).toHaveCount(1);
  await expect(episodes(page).first()).toContainText('Reduction firing');
  await page.getByRole('button', { name: 'Search this show' }).click();
  await expect(episodes(page)).toHaveCount(2);

  // More is a sheet: Escape closes it.
  const more = page.getByRole('button', { name: `More for ${SHOW}` });
  const sheet = page.getByRole('dialog', { name: `More for ${SHOW}` });
  await more.click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Move to a folder' })).toBeVisible();
  await axe(page);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Mark all as heard: nothing unheard here, and its count gone from the grid.
  await more.click();
  await sheet.getByRole('button', { name: 'Mark all as heard' }).click();
  await expect(sheet).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: 'Marked 2 episodes heard.' }),
  ).toBeVisible();
  await expect(page.getByText('2 episodes · 0 unheard')).toBeVisible();
  await expect(episodes(page)).toHaveCount(0);
  await letItSave(page);
  await page.getByRole('link', { name: 'Shows', exact: true }).click();
  await expect(page).toHaveURL(/\/podcasts\/shows$/);
  await expect(squares).toHaveCount(2);
  await expect(squares.nth(1)).toHaveAccessibleName(SHOW);
  await expect(squares.nth(0)).toHaveAccessibleName(`${SHOW2}, 2 unheard`);
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

/** The Queue tab's Up next rows (#249), in order. */
const upNext = (page: Page) =>
  page.getByRole('list', { name: 'Up next, drag to reorder' }).getByRole('listitem');

/**
 * Lets Refresh run again at once: the refreshFeeds callable allows one
 * a gardener every five minutes, kept on the day's usage record, which
 * is server-only, so it is cleared past the rules as admin.
 */
async function allowRefresh(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const res = await fetch(
    `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}/usage/${day}`,
    { method: 'DELETE', headers: { authorization: 'Bearer owner' } },
  );
  expect(res.ok).toBe(true);
}

// The queue (#249, step 3 of #244; Eric 2026-11-10: "A listening queue
// that new episodes append to, but can be rearranged"): two episodes
// added from Latest, in order, with the tab's count; the second moved
// up by its More, and back by its grip's arrows; Play next from an
// episode's page; one removed; one played to its end and the next
// started, the finished one gone from the queue; then New episodes
// join the queue switched on for a show, its new episode appended by
// the next look.
test('the listening queue: add, arrange, play next, remove, play through, new episodes join', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await serveEpisodes(page);
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Reader' }).check();
  await expect(page.getByRole('switch', { name: 'Podcasts' })).toBeChecked();
  await letItSave(page);
  await follow(page, FEED, SHOW, 'Listening');
  await follow(page, FEED2, SHOW2);
  await follow(page, FEED3, SHOW3);
  await page.goto('/podcasts/shows');
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('6 new articles', { timeout: 30_000 });
  const queueTab = tabs(page).getByRole('link', { name: /^Queue/ });
  await expect(queueTab).toHaveText(/^Queue\s*0/);

  // Two added from Latest: each button pressed once its episode is in.
  await tabs(page)
    .getByRole('link', { name: /^Latest/ })
    .click();
  await expect(episodes(page)).toHaveCount(6);
  for (const title of ['Reduction firing', 'Wedging clay']) {
    const add = page.getByRole('button', { name: `Add ${title} to the queue`, exact: true });
    await expect(add).toHaveAttribute('aria-pressed', 'false');
    await add.click();
    await expect(
      page.getByRole('button', { name: `${title} is in the queue`, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(queueTab).toHaveText(/^Queue\s*2/);
  await letItSave(page);

  // The Queue: in the order added, with the count and what is left.
  await queueTab.click();
  await expect(page).toHaveURL(/\/podcasts\/queue$/);
  await expect(upNext(page)).toHaveCount(2);
  await expect(upNext(page).nth(0)).toContainText('Reduction firing');
  await expect(upNext(page).nth(1)).toContainText('Wedging clay');
  await expect(upNext(page).nth(1)).toContainText(`${SHOW} · 1 h 05 min`);
  await expect(page.getByText('2 episodes · 1 h 47 min')).toBeVisible();
  await axe(page);

  // The second moved up by its More, which Escape closes.
  const more = page.getByRole('button', { name: 'More for Wedging clay', exact: true });
  const menu = page.getByRole('group', { name: 'More for Wedging clay' });
  await more.click();
  await expect(menu.getByRole('button', { name: 'Move up' })).toBeEnabled();
  await expect(menu.getByRole('button', { name: 'Move down' })).toBeDisabled();
  await axe(page);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  await menu.getByRole('button', { name: 'Move up' }).click();
  await expect(menu).toBeHidden();
  await expect(upNext(page).nth(0)).toContainText('Wedging clay');
  await expect(upNext(page).nth(1)).toContainText('Reduction firing');
  const said = page.getByRole('main').locator('[aria-live="polite"]');
  await expect(said).toHaveText('Moved Wedging clay to 1 of 2');

  // And back by its grip's arrows, said in the live region.
  const grip = page.getByRole('button', { name: 'Move Wedging clay', exact: true });
  await grip.focus();
  await page.keyboard.press('ArrowDown');
  await expect(upNext(page).nth(0)).toContainText('Reduction firing');
  await expect(upNext(page).nth(1)).toContainText('Wedging clay');
  await expect(said).toHaveText('Moved Wedging clay to 2 of 2');
  await expect(grip).toBeFocused();
  await letItSave(page);

  // Play next from an episode's page: first up next, and In the queue there.
  await tabs(page)
    .getByRole('link', { name: /^Latest/ })
    .click();
  await episodes(page)
    .getByRole('link', { name: /Testing tiles/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Testing tiles', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to the queue' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Play next' }).click();
  await expect(page.getByRole('button', { name: 'In the queue' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await letItSave(page);
  await page.getByRole('link', { name: 'Latest', exact: true }).click();
  await queueTab.click();
  await expect(upNext(page)).toHaveCount(3);
  await expect(upNext(page).nth(0)).toContainText('Testing tiles');
  await expect(upNext(page).nth(1)).toContainText('Reduction firing');
  await expect(upNext(page).nth(2)).toContainText('Wedging clay');

  // One removed.
  await page.getByRole('button', { name: 'More for Wedging clay', exact: true }).click();
  await menu.getByRole('button', { name: 'Remove from the queue' }).click();
  await expect(upNext(page)).toHaveCount(2);
  await expect(said).toHaveText('Removed Wedging clay from the queue');
  await expect(queueTab).toHaveText(/^Queue\s*2/);
  await letItSave(page);
  const queued = async () =>
    (
      (await call('list_feed_items', { queued: true })) as {
        title: string;
        queuePosition: number;
      }[]
    ).map((i) => [i.title, i.queuePosition]);
  expect(await queued()).toEqual([
    ['Testing tiles', 1],
    ['Reduction firing', 2],
  ]);

  // Played from its row, to its end: the next starts, the finished one
  // leaves the queue (the fixture audio is six seconds).
  await page.getByRole('button', { name: 'More for Testing tiles', exact: true }).click();
  await page
    .getByRole('group', { name: 'More for Testing tiles' })
    .getByRole('button', { name: 'Play', exact: true })
    .click();
  const now = page.getByRole('region', { name: 'Now playing' });
  await expect(now).toContainText('Testing tiles');
  await expect(upNext(page)).toHaveCount(1);
  await expect(upNext(page).first()).toContainText('Reduction firing');
  await expect(now).toContainText('Reduction firing', { timeout: 20_000 });
  await expect(upNext(page)).toHaveCount(0);
  await expect(page.getByText('Nothing up next.')).toBeVisible();
  const bar = page.getByRole('complementary', { name: 'Now playing' });
  await expect(bar.getByRole('button', { name: 'Pause' })).toBeVisible();
  // And that one to its end too: the queue is empty, and nothing plays.
  await expect(queueTab).toHaveText(/^Queue\s*0/, { timeout: 20_000 });
  await expect(bar.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await axe(page);
  await letItSave(page);

  // New episodes join the queue, switched on for Wheel talk: its next
  // look's new episode is appended; the first look's two were not.
  await tabs(page).getByRole('link', { name: 'Shows' }).click();
  await grid(page).getByRole('link', { name: SHOW3 }).click();
  await expect(page.getByRole('heading', { name: SHOW3, level: 1 })).toBeVisible();
  const joins = page.getByRole('switch', { name: /New episodes join the queue/ });
  await expect(joins).not.toBeChecked();
  await joins.check();
  await expect(joins).toBeChecked();
  await letItSave(page);
  await allowRefresh();
  await page.goto('/podcasts/shows');
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('1 new article', { timeout: 30_000 });
  await queueTab.click();
  await expect(upNext(page)).toHaveCount(1);
  await expect(upNext(page).first()).toContainText('Trimming feet');
  await expect(upNext(page).first()).toContainText(`${SHOW3} · 19 min`);
  expect(await queued()).toEqual([['Trimming feet', 1]]);
});
