import AxeBuilder from '@axe-core/playwright';
import { crc32 } from 'node:zlib';
import { type Page, type Route, devices } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, prepPage, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The Reader (#159): the module switched on, an OPML file imported into
// folders (#160), the server's refresh against the emulator's fixture
// feeds (#161), then reading: folders with counts, the compact list,
// swipes, the article, next by keyboard, the caught-up page past a
// shelf's last article, Saved, Mark all read (#162), marking read on
// scroll with its Undo (#172), what is new in each folder, in Right
// Now (#173), a podcast's episodes on their own shelf (#178), search
// across every article and its index (#175), and last, feed discovery
// from a site's address (#174), and a folder named for a special
// shelf, renamed (#185). Feedly's full export, its saves and boards,
// has a journey of its own (#176).

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Eric subscriptions in feedly Cloud</title></head>
  <body>
    <outline text="Design" title="Design">
      <outline type="rss" text="Design notes" xmlUrl="https://feeds.invalid/design.xml" htmlUrl="https://design.invalid/"/>
      <outline type="rss" text="Kottke" xmlUrl="https://kottke.org/main/index.xml" htmlUrl="https://kottke.org/"/>
    </outline>
    <outline text="Games">
      <outline type="rss" text="Dice" xmlUrl="https://feeds.invalid/games.atom"/>
    </outline>
    <outline type="rss" text="Loose" xmlUrl="https://loose.example/rss"/>
  </body>
</opml>`;

const swipe = async (page: Page, text: string, dx: number) => {
  const row = page
    .getByRole('list', { name: 'Articles' })
    .getByRole('listitem')
    .filter({ hasText: text });
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
};

const axe = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
};

test('import feeds, refresh, read through a folder with swipes and keys, save, mark all read', async ({
  page,
}) => {
  // The whole Reader in one journey runs past the default 30 s once
  // read on scroll (#172) is in it; each step keeps its own timeout.
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await page.goto('/browse');
  await expect(page.getByRole('link', { name: /^Reader/ })).toHaveCount(0);
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Reader' }).check();
  await letItSave(page);
  await page.goto('/browse');
  await page.getByRole('link', { name: /^Reader/ }).click();
  await expect(page.getByRole('heading', { name: 'Reader', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Import a file from your reader' }).click();
  await expect(page.getByRole('heading', { name: 'Manage feeds', level: 1 })).toBeVisible();

  // Step 1: the file, twice; a move; a removal; one followed by its link.
  await page.getByLabel('Choose an OPML file').setInputFiles({
    name: 'feedly.opml',
    mimeType: 'text/x-opml',
    buffer: Buffer.from(OPML),
  });
  await expect(page.getByRole('status')).toContainText('4 feeds added');
  const folders = page.getByRole('list', { name: 'Folders' });
  const groups = folders.getByRole('group');
  await expect(groups).toHaveCount(3);
  await expect(groups).toContainText(['Design', 'Games', 'Uncategorized']);
  await folders.locator('summary', { hasText: 'Design' }).click();
  const design = page.getByRole('list', { name: 'Feeds in Design' });
  await expect(design.getByRole('listitem')).toHaveCount(2);
  await expect(design).toContainText('design.invalid · not looked at yet');
  await axe(page);
  await page.getByLabel('Choose an OPML file').setInputFiles({
    name: 'feedly.opml',
    mimeType: 'text/x-opml',
    buffer: Buffer.from(OPML),
  });
  await expect(page.getByRole('status')).toContainText('0 feeds added, 4 already followed');
  const kottke = design.getByRole('textbox', { name: 'Folders for Kottke, comma separated' });
  await kottke.fill('Apple, Design');
  await kottke.press('Enter');
  await expect(folders).toContainText('Apple');
  await folders.locator('summary', { hasText: 'Uncategorized' }).click();
  await page.getByRole('button', { name: 'Remove: Loose' }).click();
  await expect(folders).not.toContainText('Uncategorized');
  await page.getByRole('textbox', { name: 'Feed link' }).fill('https://feeds.invalid/page.html');
  await page.getByRole('combobox', { name: 'Folder' }).fill('Games');
  await page.getByRole('button', { name: 'Follow' }).click();
  await expect(page.getByRole('status').last()).toContainText('Following');
  // A podcast (#178), followed by its link: one more feed, two more articles below.
  await page.getByRole('textbox', { name: 'Feed link' }).fill('https://feeds.invalid/pod.xml');
  await page.getByRole('combobox', { name: 'Folder' }).fill('Listening');
  await page.getByRole('button', { name: 'Follow' }).click();
  await expect(page.getByRole('textbox', { name: 'Feed link' })).toHaveValue('');
  await letItSave(page);

  // Step 2: Refresh from the front; the fixtures answer, the rest cannot be reached.
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Reader', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Looked at 5 feeds: 7 new articles, 2 could not be read.',
    { timeout: 30_000 },
  );
  const nav = page.getByRole('navigation', { name: 'Folders' });
  await expect(nav.getByRole('link', { name: /^All/ })).toContainText('7 unread');
  await expect(nav.getByRole('link', { name: /^Design/ })).toContainText('3 unread');
  await expect(nav.getByRole('link', { name: /^Games/ })).toContainText('2 unread');
  await expect(nav.getByRole('link', { name: /^Apple/ })).not.toContainText('unread');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('Refreshed a moment ago');

  // Search across every article (#175), from the front: the server's
  // word index, which the fetcher wrote; "chairs" finds the chairs.
  const searchBox = page.getByRole('searchbox', { name: 'Search articles' });
  await searchBox.fill('chairs');
  await searchBox.press('Enter');
  const foundArticles = page.getByRole('list', { name: 'Articles found' });
  await expect(foundArticles.getByRole('listitem')).toHaveCount(1, { timeout: 15_000 });
  await expect(foundArticles.getByRole('link', { name: /Three chairs/ })).toContainText(
    'Design notes ·',
  );
  await searchBox.fill('zeppelin');
  await searchBox.press('Enter');
  await expect(page.getByText('Nothing found.')).toBeVisible({ timeout: 15_000 });
  await expect(foundArticles).toHaveCount(0);
  await axe(page);

  // Mark read on scroll (#172): the switch on, All in a short window
  // scrolled to its end, the rows passed marked in one batch and kept in
  // the list, the count down by as many, then Undo puts them back.
  await page.goto('/settings');
  const onScroll = page.getByRole('switch', { name: 'Mark articles read as I scroll past them' });
  await expect(onScroll).not.toBeChecked();
  await onScroll.check();
  await letItSave(page);
  await page.goto('/reader/f/all');
  const articles = page.getByRole('list', { name: 'Articles' });
  await expect(articles.getByRole('listitem')).toHaveCount(7);
  const tall = page.viewportSize()!;
  await page.setViewportSize({ width: tall.width, height: 320 });
  // A wheel, not a scrollTo: a page the browser moves marks nothing (review on #182).
  await page.mouse.move(tall.width / 2, 160);
  await page.mouse.wheel(0, 2000);
  const marked = page.getByRole('status').filter({ hasText: /Marked \d+ read/ });
  await expect(marked).toBeVisible();
  const passed = Number(/Marked (\d+) read/.exec(await marked.innerText())![1]);
  expect(passed).toBeGreaterThan(0);
  expect(passed).toBeLessThan(7);
  await expect(articles.getByRole('listitem')).toHaveCount(7);
  await letItSave(page);
  expect(await call('list_feed_items', {})).toHaveLength(7 - passed);
  // Undo shows where the list was scrolled to, before any click scrolls to it.
  const undo = page.getByRole('button', { name: 'Undo' });
  const box = (await undo.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await undo.click();
  await expect(page.getByRole('status')).toContainText(`${passed} unread again.`);
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await letItSave(page);
  expect(await call('list_feed_items', {})).toHaveLength(7);
  // Off again, so the lists below are only what the swipes and taps do.
  await page.setViewportSize(tall);
  await page.goto('/settings');
  await onScroll.uncheck();
  await letItSave(page);
  await page.goto('/reader');
  await expect(nav.getByRole('link', { name: /^All/ })).toContainText('7 unread');

  // Podcasts (#178): the shelf after Saved, episodes with their length; the feed marked.
  const podcasts = nav.getByRole('link', { name: /^Podcasts/ });
  await expect(podcasts).toContainText('2 unread');
  await podcasts.click();
  await expect(page.getByRole('heading', { name: 'Podcasts', level: 1 })).toBeVisible();
  const episodes = page.getByRole('list', { name: 'Articles' }).getByRole('listitem');
  await expect(episodes).toHaveCount(2);
  await expect(episodes.first()).toContainText('Reduction firing');
  await expect(episodes.first()).toContainText('42 min');
  await expect(episodes.nth(1)).toContainText('1 h 05 min');
  await expect(episodes.first().getByRole('img', { name: 'episode' })).toBeVisible();
  await axe(page);
  await page.getByRole('link', { name: 'Back' }).click();
  await page.getByRole('link', { name: 'Manage feeds' }).click();
  await folders.locator('summary', { hasText: 'Listening' }).click();
  await expect(page.getByRole('list', { name: 'Feeds in Listening' })).toContainText(
    'pod.invalid · podcast',
  );
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Reader', level: 1 })).toBeVisible();

  // What is new, in Right Now (#173): a line per folder never opened,
  // which goes once its list is opened; opening reads nothing.
  await page.goto('/right-now');
  const fresh = page.getByRole('list', { name: 'New in the Reader' });
  // Most first, then by name; Apple's one feed could not be read.
  await expect(fresh.getByRole('link')).toHaveText([
    '3 new in Design',
    '2 new in Games',
    '2 new in Listening',
  ]);
  await fresh.getByRole('link', { name: /new in Design/ }).click();
  await expect(page.getByRole('heading', { name: 'Design', level: 1 })).toBeVisible();
  await expect(articles.getByRole('listitem')).toHaveCount(3);
  await letItSave(page);
  await page.goto('/right-now');
  await expect(fresh.getByRole('link')).toHaveText(['2 new in Games', '2 new in Listening']);
  await expect(page.getByRole('link', { name: /new in Design/ })).toHaveCount(0);
  await page.goto('/reader');
  await expect(nav.getByRole('link', { name: /^Design/ })).toContainText('3 unread');

  // Step 3: the list, a swipe, the article, next by key, Show read.
  await nav.getByRole('link', { name: /^Design/ }).click();
  await expect(page.getByRole('heading', { name: 'Design', level: 1 })).toBeVisible();
  await expect(articles.getByRole('listitem')).toHaveCount(3);
  await expect(articles.getByRole('listitem').first()).toContainText('Three chairs');
  await expect(articles.getByRole('listitem').first()).toContainText('Design notes ·');
  await expect(articles.getByRole('listitem').first()).toContainText(
    'A look at three chairs worth sitting in. One Two',
  );
  await axe(page);
  await swipe(page, 'A quiet week', -120);
  await expect(articles.getByRole('listitem')).toHaveCount(2);
  await articles.getByRole('link', { name: /Three chairs/ }).click();
  await expect(page.getByRole('heading', { name: 'Three chairs', level: 1 })).toBeVisible();
  const body = page.locator('.body');
  await expect(body.locator('strong')).toHaveText('three chairs');
  await expect(body).not.toContainText('ignore the gardener');
  await expect(body.getByRole('listitem')).toHaveText(['One', 'Two']);
  await expect(page.getByRole('link', { name: 'Open the page' })).toHaveAttribute(
    'href',
    'https://design.invalid/three-chairs',
  );
  await expect(page.getByRole('button', { name: 'Keep unread' })).toBeVisible();
  await axe(page);

  // Step 4: reader mode fetches the page's article; File in the garden makes a clipping.
  await page.getByRole('button', { name: 'Reader mode' }).click();
  await expect(body).toContainText('the full essay', { timeout: 30_000 });
  await expect(body).not.toContainText('Subscribe to the newsletter');
  await expect(body.getByRole('listitem')).toHaveText(['One', 'Two', 'Three']);
  await page.getByRole('button', { name: 'File in the garden' }).click();
  await expect(page.getByRole('status')).toContainText('Filed in the garden.');
  await page.getByRole('link', { name: 'In the garden' }).click();
  const clipping = page.getByRole('region', { name: 'Clipping' });
  await expect(clipping).toContainText('Clipped from design.invalid');
  await expect(clipping.getByRole('link', { name: 'Open the page' })).toHaveAttribute(
    'href',
    'https://design.invalid/three-chairs',
  );
  await expect(page.getByRole('textbox', { name: 'New note' })).toContainText('the full essay');
  await letItSave(page);
  await page.goto('/browse/clippings');
  await expect(page.getByRole('link', { name: /Three chairs/ })).toBeVisible();
  await page.goBack();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Three chairs', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'In the garden' })).toBeVisible();
  await page.keyboard.press('j');
  await expect(page.getByRole('heading', { name: 'Celadon glazes', level: 1 })).toBeVisible();
  // Swipe right goes back to the story just read, swipe left forward again.
  const pageSwipe = async (dx: number) => {
    const box = (await page.locator('main').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 60;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 4 });
    await page.mouse.move(x + dx, y, { steps: 4 });
    await page.mouse.up();
  };
  await pageSwipe(140);
  await expect(page.getByRole('heading', { name: 'Three chairs', level: 1 })).toBeVisible();
  await pageSwipe(-140);
  await expect(page.getByRole('heading', { name: 'Celadon glazes', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Save for later' }).click();
  await expect(page.getByRole('button', { name: 'Unsave' })).toBeVisible();
  // Past the shelf's last article, the caught-up page (Eric, 2026-11-07);
  // a swipe right goes back to that article, Back to the list.
  const caughtUp = page.getByRole('heading', { name: 'You are all caught up', level: 1 });
  await pageSwipe(-140);
  await expect(caughtUp).toBeVisible();
  await expect(page).toHaveURL(/\/reader\/done\?in=f(:|%3A)Design$/);
  await expect(page.getByText('Nothing more in Design.')).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'A goblin opens an empty box, and a fly buzzes out of it' }),
  ).toBeVisible();
  await axe(page);
  await pageSwipe(140);
  await expect(page.getByRole('heading', { name: 'Celadon glazes', level: 1 })).toBeVisible();
  // A fresh article page, and the story read on the way is still behind it (#188).
  await pageSwipe(140);
  await expect(page.getByRole('heading', { name: 'Three chairs', level: 1 })).toBeVisible();
  await pageSwipe(-140);
  await expect(page.getByRole('heading', { name: 'Celadon glazes', level: 1 })).toBeVisible();
  // And after a reload: this tab kept them.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Celadon glazes', level: 1 })).toBeVisible();
  await page.keyboard.press('k');
  await expect(page.getByRole('heading', { name: 'Three chairs', level: 1 })).toBeVisible();
  await page.keyboard.press('j');
  await expect(page.getByRole('heading', { name: 'Celadon glazes', level: 1 })).toBeVisible();
  await page.keyboard.press('j');
  await expect(caughtUp).toBeVisible();
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Design', level: 1 })).toBeVisible();
  await expect(page.getByText('All caught up.')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Show read' }).check();
  await expect(articles.getByRole('listitem')).toHaveCount(3);
  await expect(articles.getByRole('listitem').filter({ hasText: 'Celadon' })).toContainText('★');

  // Saved is a folder; Games is marked read in one go.
  // Saved for later went to the reading queue too, by its link.
  await page.goto('/reading');
  await expect(page.getByRole('list', { name: 'Reading queue' })).toContainText(
    'https://design.invalid/celadon',
  );
  await page.goto('/reader/f/saved');
  await expect(page.getByRole('heading', { name: 'Saved', level: 1 })).toBeVisible();
  // Saved keeps what is saved, read or not.
  await expect(articles.getByRole('listitem')).toHaveCount(1);
  await expect(articles.getByRole('listitem').first()).toContainText('Celadon glazes');
  await page.goto('/browse');
  // Games' two, and the podcast's two episodes (#178).
  await expect(page.getByRole('link', { name: /^Reader/ })).toContainText('4 unread');
  await page.goto('/reader/f/Games');
  await expect(articles.getByRole('listitem')).toHaveCount(2);
  await expect(articles.getByRole('listitem').first()).toContainText('Dice ·');
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('status')).toContainText('2 marked read.');
  await expect(page.getByText('All caught up.')).toBeVisible();

  // The assistant's side: the same articles, labelled as web content, and a clipping of its own.
  const games = (await call('list_feed_items', { folder: 'Games', includeRead: true })) as {
    id: string;
    title: string;
    fromWeb: string;
    feed: string;
  }[];
  expect(games.map((g) => g.title)).toEqual(['A one-page dungeon', 'Rules light, story heavy']);
  expect(games[0].fromWeb).toContain('content from the web');
  expect(games[0].feed).toBe('Dice');
  const one = (await call('get_feed_item', { id: games[0].id })) as { text: string; total: number };
  expect(one.text).toContain('Twelve rooms');
  const hits = (await call('search_feed_items', { query: 'dungeon', days: 365 })) as {
    id: string;
    snippet: string;
  }[];
  expect(hits.map((h) => h.id)).toEqual([games[0].id]);
  // Across every article (#175), no date window: the word index.
  const celadon = (await call('search_feed_items', { query: 'celadon' })) as {
    title: string;
    fromWeb: string;
  }[];
  expect(celadon.map((h) => h.title)).toEqual(['Celadon glazes']);
  expect(celadon[0].fromWeb).toContain('content from the web');
  const clipped = (await call('clip_feed_item', { id: games[0].id, tags: ['rpg'] })) as {
    id: string;
    title: string;
  };
  expect(clipped.title).toBe('A one-page dungeon');
  const note = (await call('get_note', { id: clipped.id })) as { fromWeb?: string; body: string };
  expect(note.fromWeb).toContain('Clipped from https://feeds.invalid/one-page');
  expect(note.body).toContain('Twelve rooms');
  const again = (await call('clip_feed_item', { id: games[0].id })) as { id: string };
  expect(again.id).toBe(clipped.id);

  // Images are a setting of the gardener's, kept across devices.
  await page.goto('/settings');
  const images = page.getByRole('switch', { name: 'Show images in articles' });
  await expect(images).toBeChecked();
  await images.uncheck();
  await letItSave(page);
  await page.reload();
  await expect(images).not.toBeChecked();

  // Retention (#171): keep for three months, applied to what is stored; the sweep.
  await page.getByRole('combobox', { name: 'Keep articles for' }).selectOption('3');
  await expect(page.getByRole('status').last()).toContainText(
    /Keeping articles for 3 months; applied to \d+ stored/,
    { timeout: 15_000 },
  );
  await page
    .getByRole('button', { name: 'Remove unread articles older than three months' })
    .click();
  await expect(page.getByRole('status').last()).toContainText('Removed 0 old unread articles.', {
    timeout: 15_000,
  });
  // The word index for what was stored before it (#175): the fetcher
  // and reader mode indexed every article here already.
  await page.getByRole('button', { name: 'Index articles for search' }).click();
  await expect(page.getByRole('status').last()).toHaveText('Indexed 0 articles.', {
    timeout: 15_000,
  });

  // Discovery (#174), last so the counts above stand: the link followed
  // in step 1 is a page, and the server finds no feed there; a site's
  // address lists the three feeds its head names. One the OPML did not
  // have is followed into a new folder, and one already followed joins
  // it there.
  await page.goto('/reader/feeds');
  await folders.locator('summary', { hasText: 'Games' }).click();
  await expect(page.getByRole('list', { name: 'Feeds in Games' })).toContainText(
    'last look failed: not a feed',
  );
  await page.getByRole('button', { name: 'Find feeds at the site of feeds.invalid' }).click();
  const followStatus = page.locator('#follow ~ [role=status]');
  await expect(followStatus).toHaveText('No feed found at that address.', { timeout: 15_000 });
  await page.getByRole('textbox', { name: 'Feed link' }).fill('https://site.invalid/');
  await page.getByRole('combobox', { name: 'Folder' }).fill('Tabletop');
  await page.getByRole('button', { name: 'Find feeds', exact: true }).click();
  const found = page.getByRole('list', { name: 'Feeds found' });
  await expect(found.getByRole('listitem')).toHaveCount(3, { timeout: 15_000 });
  await expect(found.getByRole('listitem')).toContainText([
    'Design notes (fixture)',
    'Dice and paper (fixture)',
    'Margin notes (fixture)',
  ]);
  await expect(found.getByRole('listitem').nth(1)).toContainText(
    'https://feeds.invalid/games.atom · already followed',
  );
  await expect(found.getByRole('listitem').last()).not.toContainText('already followed');
  await expect(followStatus).toHaveText('Found 3 feeds; pick one below.');
  await axe(page);
  await found.getByRole('button', { name: 'Follow: Margin notes (fixture)' }).click();
  await expect(followStatus).toHaveText(
    'Following Margin notes (fixture). Its articles arrive once the server has looked.',
  );
  await expect(found).toHaveCount(0);
  await folders.locator('summary', { hasText: 'Tabletop' }).click();
  const tabletop = page.getByRole('list', { name: 'Feeds in Tabletop' });
  await expect(tabletop.getByRole('listitem')).toHaveCount(1);
  await expect(tabletop).toContainText('Margin notes (fixture)');
  await expect(tabletop).toContainText('feeds.invalid · not looked at yet');
  // Again, for one already followed: it keeps its name and joins the folder.
  await page.getByRole('textbox', { name: 'Feed link' }).fill('https://site.invalid/');
  await page.getByRole('button', { name: 'Find feeds', exact: true }).click();
  await expect(found.getByRole('listitem')).toHaveCount(3, { timeout: 15_000 });
  await expect(found.getByRole('listitem').last()).toContainText('already followed');
  await found.getByRole('button', { name: 'Follow: Dice and paper (fixture)' }).click();
  await expect(followStatus).toHaveText('Already following Dice; now in Tabletop too.');
  await expect(tabletop.getByRole('listitem')).toHaveCount(2);
  await expect(tabletop).toContainText('Dice');
  // A folder named for a special shelf (#185) is renamed, so it keeps its own feeds.
  await page.getByRole('textbox', { name: 'Feed link' }).fill('https://feeds.invalid/all.xml');
  await page.getByRole('combobox', { name: 'Folder' }).fill('All');
  await page.getByRole('button', { name: 'Follow' }).click();
  await expect(followStatus).toHaveText(
    "Following. Its name and articles arrive once the server has looked. A folder cannot be called 'All'; it is in 'All (folder)'.",
  );
  await expect(folders.locator('summary', { hasText: 'All (folder)' })).toBeVisible();
});

/**
 * A zip as Feedly's export is one (#176), each file stored, built here
 * so the journey carries no binary fixture.
 */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(body);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(dir, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

// Feedly's full export (#176): the zip's OPML brings the feeds, its
// saves come in as saved, read articles, a board's name a tag on its
// articles, the newest in the reading queue; no unread count moves,
// and the feed with no link they are filed under is never looked at.
test('import Feedly’s full export: the feeds, the saves, boards as tags', async ({ page }) => {
  test.setTimeout(60_000);
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Reader' }).check();
  await letItSave(page);
  await page.goto('/reader/feeds');
  // The form waits for the feeds to be read, as the first journey's does by arriving later.
  await expect(page.getByLabel('Choose an OPML file')).toBeEnabled();
  const saved = JSON.stringify({
    id: 'user/u1/tag/global.saved',
    items: [
      {
        id: 'entry-1',
        originId: 'tag:design.invalid,teapots',
        title: 'Teapots that pour',
        alternate: [{ href: 'https://design.invalid/teapots', type: 'text/html' }],
        origin: { streamId: 'feed/https://feeds.invalid/design.xml', title: 'Design notes' },
        published: Date.now() - 86_400_000,
        summary: { content: '<p>A spout that does not drip. Do [[this]] @goblin</p>' },
        tags: [{ id: 'user/u1/tag/global.saved', label: 'Saved For Later' }],
      },
      {
        id: 'entry-2',
        originId: 'https://elsewhere.invalid/kilns',
        title: 'Kilns, briefly',
        alternate: [{ href: 'https://elsewhere.invalid/kilns' }],
        origin: { streamId: 'feed/https://elsewhere.invalid/rss', title: 'Elsewhere' },
        published: Date.now() - 2 * 86_400_000,
        content: { content: '<p>Cone six.</p>' },
        tags: [{ id: 'user/u1/tag/global.saved' }],
      },
    ],
  });
  const board = JSON.stringify({
    id: 'user/u1/tag/Pottery',
    label: 'Pottery',
    items: [JSON.parse(saved).items[1]],
  });
  const zip = {
    name: 'feedly-export.zip',
    mimeType: 'application/zip',
    buffer: storedZip({
      'feedly-export/feedly.opml': OPML,
      'feedly-export/saved.json': saved,
      'feedly-export/boards/Pottery.json': board,
    }),
  };
  await page.getByLabel('Choose an OPML file').setInputFiles(zip);
  const status = page.getByRole('status');
  await expect(status).toHaveText(
    '4 feeds added. Imported 2 saved articles (0 already here); boards became tags. The newest 2 went to the reading queue.',
    { timeout: 15_000 },
  );
  // The one from a feed not followed is under the Feedly saves, which has no link to look at.
  const folders = page.getByRole('list', { name: 'Folders' });
  await folders.locator('summary', { hasText: 'Uncategorized' }).click();
  await expect(page.getByRole('list', { name: 'Feeds in Uncategorized' })).toContainText(
    'Feedly saves',
  );
  await expect(page.getByRole('list', { name: 'Feeds in Uncategorized' })).toContainText(
    'nothing to look at',
  );
  await axe(page);

  // Saved: both, read, the board's name a chip; the page's brackets stay words.
  await page.goto('/reader/f/saved');
  const articles = page.getByRole('list', { name: 'Articles' });
  await expect(articles.getByRole('listitem')).toHaveCount(2);
  const teapots = articles.getByRole('listitem').filter({ hasText: 'Teapots that pour' });
  await expect(teapots).toContainText('Design notes ·');
  await expect(teapots.locator('.tag')).toHaveCount(0);
  const kilns = articles.getByRole('listitem').filter({ hasText: 'Kilns, briefly' });
  await expect(kilns).toContainText('Feedly saves ·');
  await expect(kilns.locator('.tag')).toHaveText(['Pottery']);
  await axe(page);
  await page.goto('/reading');
  await expect(page.getByRole('list', { name: 'Reading queue' })).toContainText(
    'https://elsewhere.invalid/kilns',
  );

  // Refresh looks at the OPML's four feeds, not the Feedly saves; the saves move no unread count.
  await page.goto('/reader');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Looked at 4 feeds: 5 new articles, 2 could not be read.',
    { timeout: 30_000 },
  );
  const nav = page.getByRole('navigation', { name: 'Folders' });
  await expect(nav.getByRole('link', { name: /^All/ })).toContainText('5 unread');
  await expect(nav.getByRole('link', { name: /^Design/ })).toContainText('3 unread');

  // The assistant finds a board's articles by its tag, labelled as web content.
  const pottery = (await call('list_feed_items', { tag: 'pottery', saved: true })) as {
    title: string;
    tags: string[];
    fromWeb: string;
    feed: string;
  }[];
  expect(pottery.map((p) => p.title)).toEqual(['Kilns, briefly']);
  expect(pottery[0].tags).toEqual(['Pottery']);
  expect(pottery[0].feed).toBe('Feedly saves');
  expect(pottery[0].fromWeb).toContain('content from the web');
  expect(await call('list_feed_items', {})).toHaveLength(5);

  // The same file again is once.
  await page.goto('/reader/feeds');
  await expect(page.getByLabel('Choose an OPML file')).toBeEnabled();
  await page.getByLabel('Choose an OPML file').setInputFiles(zip);
  await expect(status).toHaveText(
    '0 feeds added, 4 already followed. Imported 0 saved articles (2 already here); boards became tags.',
    { timeout: 15_000 },
  );
});

/**
 * The fixture episode's audio (#179): six seconds of silence, 8 kHz
 * 8-bit mono PCM, so it plays in the browser and ends soon.
 */
function silentWav(seconds = 6, rate = 8000): Buffer {
  const samples = seconds * rate;
  const wav = Buffer.alloc(44 + samples, 0x80);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  return wav;
}

/**
 * The fixture feed's enclosures (pod.invalid) cannot be reached from
 * the browser: the episodes' audio is the silent file, served here,
 * a byte range when one is asked for; the artwork is refused. On the
 * context, not the page: the service worker's fetches are the context's.
 */
async function serveEpisodes(page: Page): Promise<void> {
  const wav = silentWav();
  await page.context().route(/^https:\/\/pod\.invalid\//, (route) => {
    if (!route.request().url().endsWith('.mp3')) return route.abort();
    return answerWav(route, wav);
  });
}

/** The silent file, or the byte range of it the request asks for. */
function answerWav(route: Route, wav: Buffer): Promise<void> {
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '');
  if (!range) {
    return route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      headers: { 'accept-ranges': 'bytes' },
      body: wav,
    });
  }
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
  return route.fulfill({
    status: 206,
    contentType: 'audio/wav',
    headers: {
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${wav.length}`,
    },
    body: wav.subarray(start, end + 1),
  });
}

/**
 * The Worker's episode proxy (#180) has no stand-in in the e2e suite:
 * the app is served by scripts/serve-static.mjs, not by the Worker, and
 * the Worker checks real Google-signed tokens. The journey answers
 * `/api/episode?url=…` here instead, as the proxy would for the fixture
 * episode, and records each request's Authorization header. On the
 * context, so the service worker's fetches on a cache miss reach it.
 */
async function serveProxy(page: Page): Promise<string[]> {
  const wav = silentWav();
  const asked: string[] = [];
  await page.context().route(/\/api\/episode\?/, async (route) => {
    asked.push((await route.request().allHeaders())['authorization'] ?? '');
    const link = new URL(route.request().url()).searchParams.get('url') ?? '';
    if (!/^https:\/\/pod\.invalid\/.*\.mp3$/.test(link)) return route.fulfill({ status: 415 });
    return answerWav(route, wav);
  });
  return asked;
}

// The player (#179): the podcast followed and looked at, its first
// episode played and paused, the place kept across a reload and shown
// on another device under Continue listening, then heard to the end,
// which marks it played and read.
test('play an episode, keep the place across a reload and on another device', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await serveEpisodes(page);
  await signInAs(page, OWNER);
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Reader' }).check();
  await letItSave(page);
  await page.goto('/reader/feeds');
  await page.getByRole('textbox', { name: 'Feed link' }).fill('https://feeds.invalid/pod.xml');
  await page.getByRole('combobox', { name: 'Folder' }).fill('Listening');
  await page.getByRole('button', { name: 'Follow' }).click();
  await expect(page.getByRole('textbox', { name: 'Feed link' })).toHaveValue('');
  await letItSave(page);
  await page.getByRole('link', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('2 new articles', { timeout: 30_000 });
  const nav = page.getByRole('navigation', { name: 'Folders' });
  const podcasts = nav.getByRole('link', { name: /^Podcasts/ });
  await expect(podcasts).toContainText('2 unread');
  await expect(page.getByRole('list', { name: 'Continue listening' })).toHaveCount(0);

  // The episode's page: play, then pause past the first second.
  await podcasts.click();
  await page
    .getByRole('list', { name: 'Articles' })
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
  // Opening an episode reads nothing; only the end does.
  await expect(page.getByRole('button', { name: 'Mark read' })).toBeVisible();
  await letItSave(page);

  // A reload finds it where it was, paused.
  await page.reload();
  await expect(slider).toHaveAttribute('aria-valuetext', `${kept} of 42:10`);
  await expect(player.getByRole('button', { name: 'Play' })).toBeVisible();
  await page.goto('/reader');
  const bar = page.getByRole('complementary', { name: 'Now playing' });
  await expect(bar).toContainText('Reduction firing');
  await expect(bar).toContainText(`${kept} / 42:10`);
  const listening = page.getByRole('list', { name: 'Continue listening' });
  await expect(listening.getByRole('listitem')).toHaveCount(1);
  await expect(listening).toContainText('Reduction firing');
  await expect(listening).toContainText(`${kept} of 42:10`);
  await axe(page);

  // Another device sees the place, and its episode page starts there.
  const other = await browser.newContext({ ...devices['Pixel 7'] });
  const second = await other.newPage();
  await prepPage(second);
  await serveEpisodes(second);
  await signInAs(second, OWNER, { reset: false });
  await second.goto('/reader');
  const elsewhere = second.getByRole('list', { name: 'Continue listening' });
  await expect(elsewhere).toContainText('Reduction firing');
  await expect(elsewhere).toContainText(`${kept} of 42:10`);
  await elsewhere.getByRole('link', { name: /Reduction firing/ }).click();
  await expect(
    second.getByRole('region', { name: 'Player' }).getByRole('slider', { name: 'Position' }),
  ).toHaveAttribute('aria-valuetext', `${kept} of 42:10`);

  // Heard to the end from the mini-player: played and read, here and there.
  await bar.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(bar.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(listening).toHaveCount(0, { timeout: 15_000 });
  await expect(bar.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(podcasts).toContainText('1 unread');
  await expect(second.getByRole('button', { name: 'Keep unread' })).toBeVisible();
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
  await page.goto('/settings');
  await page.getByRole('switch', { name: 'Reader' }).check();
  await letItSave(page);
  await expect(
    page.getByRole('combobox', { name: 'Downloaded episodes kept on this device, at most' }),
  ).toHaveValue('500');
  await expect(
    page.getByRole('switch', { name: 'Download new episodes on their own only on Wi-Fi' }),
  ).toBeChecked();
  await page.goto('/reader/feeds');
  await page.getByRole('textbox', { name: 'Feed link' }).fill('https://feeds.invalid/pod.xml');
  await page.getByRole('combobox', { name: 'Folder' }).fill('Listening');
  await page.getByRole('button', { name: 'Follow' }).click();
  await expect(page.getByRole('textbox', { name: 'Feed link' })).toHaveValue('');
  await letItSave(page);
  await page.getByRole('link', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('2 new articles', { timeout: 30_000 });
  // Nothing downloaded and no podcast keeping any: no Downloads link yet.
  await expect(page.getByRole('link', { name: 'Downloads' })).toHaveCount(0);

  // Download from the episode's page: through the proxy, with the ID token.
  const nav = page.getByRole('navigation', { name: 'Folders' });
  await nav.getByRole('link', { name: /^Podcasts/ }).click();
  await page
    .getByRole('list', { name: 'Articles' })
    .getByRole('link', { name: /Reduction firing/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Reduction firing', level: 1 })).toBeVisible();
  const player = page.getByRole('region', { name: 'Player' });
  await player.getByRole('button', { name: 'Download' }).click();
  await expect(player).toContainText('Downloaded, 47 KB', { timeout: 15_000 });
  await expect(page.locator('article header .meta')).toContainText('Downloaded ·');
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatch(/^Bearer \S+$/);
  await axe(page);

  // The Downloads list: its size, the total against the cap.
  await page.getByRole('link', { name: 'Back' }).click();
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Reader', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Downloads' }).click();
  await expect(page.getByRole('heading', { name: 'Downloads', level: 1 })).toBeVisible();
  const list = page.getByRole('list', { name: 'Downloads' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('Reduction firing');
  await expect(list).toContainText('Kiln hour (fixture) · 47 KB');
  await expect(page.getByRole('status')).toHaveText('1 episode, 47 KB of 500 MB');
  await axe(page);

  // Offline: the page and the player go on, the file from the cache.
  await page.context().setOffline(true);
  await list.getByRole('link', { name: /Reduction firing/ }).click();
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
