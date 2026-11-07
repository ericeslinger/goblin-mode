import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The Reader (#159): the module switched on, an OPML file imported into
// folders (#160), the server's refresh against the emulator's fixture
// feeds (#161), then reading: folders with counts, the compact list,
// swipes, the article, next by keyboard, Saved, Mark all read (#162),
// marking read on scroll with its Undo (#172), and last, feed
// discovery from a site's address (#174).

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
  await letItSave(page);

  // Step 2: Refresh from the front; the fixtures answer, the rest cannot be reached.
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Reader', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Looked at 4 feeds: 5 new articles, 2 could not be read.',
    { timeout: 30_000 },
  );
  const nav = page.getByRole('navigation', { name: 'Folders' });
  await expect(nav.getByRole('link', { name: /^All/ })).toContainText('5 unread');
  await expect(nav.getByRole('link', { name: /^Design/ })).toContainText('3 unread');
  await expect(nav.getByRole('link', { name: /^Games/ })).toContainText('2 unread');
  await expect(nav.getByRole('link', { name: /^Apple/ })).not.toContainText('unread');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('Refreshed a moment ago');

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
  await expect(articles.getByRole('listitem')).toHaveCount(5);
  const tall = page.viewportSize()!;
  await page.setViewportSize({ width: tall.width, height: 320 });
  // A wheel, not a scrollTo: a page the browser moves marks nothing (review on #182).
  await page.mouse.move(tall.width / 2, 160);
  await page.mouse.wheel(0, 2000);
  const marked = page.getByRole('status').filter({ hasText: /Marked \d+ read/ });
  await expect(marked).toBeVisible();
  const passed = Number(/Marked (\d+) read/.exec(await marked.innerText())![1]);
  expect(passed).toBeGreaterThan(0);
  expect(passed).toBeLessThan(5);
  await expect(articles.getByRole('listitem')).toHaveCount(5);
  await letItSave(page);
  expect(await call('list_feed_items', {})).toHaveLength(5 - passed);
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
  expect(await call('list_feed_items', {})).toHaveLength(5);
  // Off again, so the lists below are only what the swipes and taps do.
  await page.setViewportSize(tall);
  await page.goto('/settings');
  await onScroll.uncheck();
  await letItSave(page);
  await page.goto('/reader');
  await expect(nav.getByRole('link', { name: /^All/ })).toContainText('5 unread');

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
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
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
  await expect(page.getByRole('link', { name: /^Reader/ })).toContainText('2 unread');
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
});
