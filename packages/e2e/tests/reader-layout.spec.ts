import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  FIRESTORE_EMULATOR,
  expect,
  letItSave,
  signInAs,
  test,
  openSettings,
} from '../src/fixtures';
import { OWNER } from '../src/personas';

// The Reader's list and article, step 4 of the layout pass (#288):
// days with their own Mark these read, the Compact density kept on
// the device, the folders as chips, and the article's smaller title
// with Keep unread and Reader mode in its top row.
//
// The articles are the emulator's fixture feeds (stand-in.emulator.ts),
// whose dates are fixed: Design notes on Nov 6, 5 and 2, 2026 at 09:00
// UTC, Dice and paper on Nov 6 and 4 at 18:00 UTC. The page's clock is
// set to the evening of Nov 6 and its zone to UTC, so the days are
// Today, Yesterday and two dated ones whatever day the suite runs.
//
// From 1320 px (#289, part 3, 2026-11-16) the Reader was three panes:
// the folders, the list and the article, under its header. Since
// 2026-11-22 (Eric: "too many columns") it is two from 1200 px: the
// header and tabs over the list, and the article; the folders are the
// Folders tab's, shown in the list pane, and a row's buttons are the
// article toolbar's icons. Under that width, and on the phone, it is
// the screens it was.

test.use({ timezoneId: 'UTC' });

/** The evening of the fixtures' newest day. */
const NOW = new Date('2026-11-06T20:00:00Z');

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Where a tap 21 px from the control's centre misses it (as layout.spec.ts). */
async function missedTaps(control: Locator): Promise<string[]> {
  return control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    const missed: string[] = [];
    for (const [dx, dy] of [
      [0, 0],
      [0, -21],
      [0, 21],
      [-14, -14],
      [14, 14],
    ] as const) {
      const hit = document.elementFromPoint(x + dx, y + dy);
      if (!hit || !el.contains(hit)) missed.push(`${dx},${dy}: ${hit?.outerHTML.slice(0, 60)}`);
    }
    return missed;
  });
}

/**
 * The Reader on, Design notes followed into Design and Dice and paper
 * into Games, refreshed: five unread articles on four days.
 */
async function readerWithFixtures(page: Page): Promise<void> {
  await signInAs(page, OWNER);
  await openSettings(page, 'Modules');
  await page.getByRole('switch', { name: 'Reader' }).check();
  await letItSave(page);
  await page.goto('/reader/feeds');
  for (const [url, folder] of [
    ['https://feeds.invalid/design.xml', 'Design'],
    ['https://feeds.invalid/games.atom', 'Games'],
  ]) {
    await page.getByRole('textbox', { name: 'Feed link' }).fill(url);
    await page.getByRole('combobox', { name: 'Folder' }).fill(folder);
    await page.getByRole('button', { name: 'Follow' }).click();
    await expect(page.getByRole('textbox', { name: 'Feed link' })).toHaveValue('');
  }
  await letItSave(page);
  await page.goto('/reader/folders');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('5 new articles', { timeout: 30_000 });
  await page.clock.setFixedTime(NOW);
}

const articles = (page: Page) => page.getByRole('group', { name: 'Articles', exact: true });
const dayHeading = (page: Page, name: string) =>
  articles(page).getByRole('heading', { level: 3, name, exact: true });
/** A day's own Mark these read, beside its heading. */
const markDay = (page: Page, name: string) =>
  articles(page)
    .locator('section')
    // Relative to the day itself: a locator rooted at the list finds nothing inside it.
    .filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) })
    .getByRole('button', { name: 'Mark these read' });

test('the list by day: headings with counts, one day marked read, and Undo', async ({ page }) => {
  await readerWithFixtures(page);
  await page.goto('/reader');
  const rows = articles(page).getByRole('listitem');
  // A section a day, each with its own list named by its heading; the
  // rows are the only list items: five articles.
  await expect(rows).toHaveCount(5);
  await expect(articles(page).locator('section')).toHaveCount(4);
  await expect(
    articles(page).getByRole('list', { name: 'Today, 2 unread', exact: true }),
  ).toHaveCount(1);
  await expect(
    articles(page)
      .getByRole('list', { name: 'Today, 2 unread', exact: true })
      .getByRole('listitem'),
  ).toHaveCount(2);
  await expect(articles(page).getByRole('heading', { level: 3 })).toHaveCount(4);
  await expect(dayHeading(page, 'Today, 2 unread')).toBeVisible();
  await expect(dayHeading(page, 'Yesterday, 1 unread')).toBeVisible();
  await expect(dayHeading(page, 'Wednesday, Nov 4, 1 unread')).toBeVisible();
  await expect(dayHeading(page, 'Monday, Nov 2, 1 unread')).toBeVisible();
  // On screen the count follows a dot.
  await expect(articles(page).locator('.day-head').first()).toContainText('Today · 2');
  // Newest first, each under its day.
  await expect(rows).toHaveText([
    /A one-page dungeon/,
    /Three chairs/,
    /Celadon glazes/,
    /Rules light, story heavy/,
    /A quiet week/,
  ]);
  // Each source has its mark, drawn on the device and hidden from screen readers.
  const mark = rows.first().locator('app-source-mark');
  await expect(mark).toHaveText('D');
  await expect(mark).toHaveAttribute('aria-hidden', 'true');
  await expect(rows.first().getByRole('link')).toHaveAccessibleName(/^A one-page dungeon/);
  await noSeriousViolations(page);

  // A day's heading sticks while its rows scroll, and the next day's
  // pushes it off.
  await page.setViewportSize({ width: 412, height: 360 });
  const intoDay = (n: number) =>
    page.evaluate((at) => {
      const day = document.querySelectorAll('[role="group"][aria-label="Articles"] > section')[at]!;
      window.scrollTo(0, window.scrollY + day.getBoundingClientRect().top + 60);
    }, n);
  const headOf = (name: string) =>
    articles(page)
      .locator('.day-head')
      .filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) });
  await expect(headOf('Today, 2 unread')).toHaveCSS('position', 'sticky');
  await intoDay(0);
  await expect
    .poll(async () => Math.round((await headOf('Today, 2 unread').boundingBox())!.y))
    .toBe(0);
  await expect(dayHeading(page, 'Today, 2 unread')).toBeInViewport();
  await intoDay(1);
  await expect
    .poll(async () => Math.round((await headOf('Yesterday, 1 unread').boundingBox())!.y))
    .toBe(0);
  await expect(dayHeading(page, 'Yesterday, 1 unread')).toBeInViewport();
  await expect(dayHeading(page, 'Today, 2 unread')).not.toBeInViewport();
  // With a heading stuck over the rows.
  await noSeriousViolations(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 412, height: 839 });

  // Mark these read on Today marks Today's two and nothing else.
  await markDay(page, 'Today, 2 unread').click();
  await expect(page.getByRole('status')).toContainText('2 marked read.');
  await expect(rows).toHaveCount(3);
  await expect(rows).toHaveText([/Celadon glazes/, /Rules light/, /A quiet week/]);
  await expect(dayHeading(page, 'Today, 2 unread')).toHaveCount(0);
  await expect(dayHeading(page, 'Yesterday, 1 unread')).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Reader screens' });
  await expect(tabs.getByRole('link', { name: /^All/ })).toContainText('3 unread');
  // Its button went with its day: the focus is on Undo, the same Undo as Mark all read's.
  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(page.getByRole('status')).toContainText('2 unread again.');
  await expect(rows).toHaveCount(5);
  await expect(dayHeading(page, 'Today, 2 unread')).toBeVisible();
  await expect(tabs.getByRole('link', { name: /^All/ })).toContainText('5 unread');

  // With Show read on, a day whose articles are all read keeps its
  // heading, with no count and nothing to mark.
  await markDay(page, 'Yesterday, 1 unread').click();
  await expect(rows).toHaveCount(4);
  // The offer lapses after a few seconds; the focus it had goes to the
  // articles, not the page.
  await expect(page.getByRole('button', { name: 'Undo' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0, { timeout: 10_000 });
  await expect(articles(page)).toBeFocused();
  await page.getByRole('checkbox', { name: 'Show read' }).check();
  await expect(rows).toHaveCount(5);
  await expect(dayHeading(page, 'Yesterday')).toBeVisible();
  await expect(
    articles(page)
      .locator('.day-head')
      .filter({ has: page.getByRole('heading', { level: 3, name: 'Yesterday', exact: true }) })
      .getByRole('button'),
  ).toHaveCount(0);

  // Mark all read stays at the top, and has the same Undo.
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('status')).toContainText('4 marked read.');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeFocused();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toContainText('4 unread again.');
  // Undo went with its offer: the focus is on the articles.
  await expect(articles(page)).toBeFocused();
  await expect(tabs.getByRole('link', { name: /^All/ })).toContainText('4 unread');
});

test('Compact: no summaries, short rows, and the choice kept on the device', async ({ page }) => {
  await readerWithFixtures(page);
  await page.goto('/reader');
  const rows = articles(page).getByRole('listitem');
  await expect(rows).toHaveCount(5);
  // Comfortable first, as the list was: the summaries show.
  await expect(rows.filter({ hasText: 'Celadon glazes' })).toContainText(
    'Why celadon is hard, and three recipes that work.',
  );
  const compact = page.getByRole('checkbox', { name: 'Compact list' });
  await expect(compact).not.toBeChecked();
  await compact.check();
  await expect(articles(page).locator('.summary')).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Celadon glazes' })).not.toContainText('Why celadon');
  const heights = async () =>
    (await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))).map(
      Math.round,
    );
  for (const h of await heights()) expect(h).toBeLessThan(80);
  // Source and time stay, on one line.
  await expect(rows.filter({ hasText: 'Celadon glazes' })).toContainText('Design notes');
  await noSeriousViolations(page);

  // Kept on this device: a reload is still Compact.
  await page.reload();
  await expect(rows).toHaveCount(5);
  await expect(page.getByRole('checkbox', { name: 'Compact list' })).toBeChecked();
  await expect(articles(page).locator('.summary')).toHaveCount(0);
  for (const h of await heights()) expect(h).toBeLessThan(80);
  expect(await page.evaluate(() => localStorage.getItem('goblin.readerDensity'))).toBe('"compact"');
  // And back.
  await page.getByRole('checkbox', { name: 'Compact list' }).uncheck();
  await expect(rows.filter({ hasText: 'Celadon glazes' })).toContainText('Why celadon');
  await noSeriousViolations(page);
});

test('the folder chips: counts, a tap filters, the current one, and no sideways page at 320 px', async ({
  page,
}) => {
  // Follows two feeds, walks the folders and files one feed in eight
  // more: about thirteen seconds alone, and past thirty once in a full
  // run (2026-11-16).
  test.setTimeout(90_000);
  await readerWithFixtures(page);
  await page.goto('/reader');
  const chips = page.getByRole('navigation', { name: 'By folder' });
  await expect(chips.getByRole('link')).toHaveText([
    'All 5 unread',
    'Design 3 unread',
    'Games 2 unread',
  ]);
  await expect(chips.getByRole('link', { name: /^All/ })).toHaveAttribute('aria-current', 'page');
  await expect(chips.locator('[aria-current]')).toHaveCount(1);
  // Each takes a 44 px tap on touch.
  for (const name of [/^All/, /^Design/]) {
    expect(await missedTaps(chips.getByRole('link', { name }))).toEqual([]);
  }

  // A chip is the folder's list, the one the Folders tab leads to.
  await chips.getByRole('link', { name: /^Games/ }).click();
  await expect(page).toHaveURL(/\/reader\/f\/Games$/);
  await expect(page.getByRole('heading', { name: 'Games', level: 2 })).toBeVisible();
  await expect(articles(page).getByRole('listitem')).toHaveCount(2);
  await expect(chips.getByRole('link', { name: /^Games/ })).toHaveAttribute('aria-current', 'page');
  await expect(chips.locator('[aria-current]')).toHaveCount(1);
  const tabs = page.getByRole('navigation', { name: 'Reader screens' });
  await expect(tabs.getByRole('link', { name: 'Folders' })).toHaveAttribute('aria-current', 'true');
  // Saved and the Folders tab have none.
  await tabs.getByRole('link', { name: 'Saved' }).click();
  await expect(page).toHaveURL(/\/reader\/f\/saved$/);
  await expect(chips).toHaveCount(0);

  // Many folders: Design notes filed in eight more.
  await page.goto('/reader/feeds');
  await page
    .getByRole('list', { name: 'Folders' })
    .locator('summary', { hasText: 'Design' })
    .click();
  const field = page
    .getByRole('list', { name: 'Feeds in Design' })
    .getByRole('textbox', { name: /^Folders for .*, comma separated$/ });
  await field.fill(
    'Design, Ceramics, Long reads, Typography, Woodworking, Science, Weekend, Kitchen garden, Tools',
  );
  await field.press('Enter');
  await expect(page.getByRole('list', { name: 'Folders' })).toContainText('Woodworking');
  await letItSave(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/reader');
  await expect(chips.getByRole('link')).toHaveCount(11);
  await expect(chips.getByRole('link', { name: /^Woodworking/ })).toContainText('3');
  // The row scrolls in itself; the page does not scroll sideways.
  const widths = await page.evaluate(() => {
    const row = document.querySelector('nav[aria-label="By folder"]')!;
    return {
      page: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
      row: row.scrollWidth,
      box: row.clientWidth,
    };
  });
  expect(widths.page).toBeLessThanOrEqual(widths.view);
  expect(widths.row).toBeGreaterThan(widths.box);
  // A chip past the edge is reached by scrolling the row, and opens its folder.
  const last = chips.getByRole('link', { name: /^Woodworking/ });
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(page).toHaveURL(/\/reader\/f\/Woodworking$/);
  await expect(last).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await noSeriousViolations(page);
});

test('the article: a smaller title, and Keep unread and Reader mode in its top row', async ({
  page,
}) => {
  await readerWithFixtures(page);
  await page.goto('/reader/f/Design');
  await articles(page)
    .getByRole('link', { name: /Three chairs/ })
    .click();
  const title = page.getByRole('heading', { name: 'Three chairs', level: 1 });
  await expect(title).toBeVisible();
  const size = await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(size).toBeLessThanOrEqual(26);
  expect(size).toBeGreaterThanOrEqual(24);

  // Both in the header's row of icons, above the title, not under it.
  const top = page.locator('main > header.top');
  const keep = top.getByRole('button', { name: 'Keep unread' });
  const readerMode = top.getByRole('button', { name: 'Reader mode' });
  await expect(keep).toBeVisible();
  await expect(readerMode).toBeVisible();
  await expect(readerMode).toHaveAttribute('aria-pressed', 'false');
  const titleTop = (await title.boundingBox())!.y;
  for (const control of [keep, readerMode, top.getByRole('button', { name: 'Save for later' })]) {
    const box = (await control.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(titleTop);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator('article header').getByRole('button')).toHaveCount(0);

  // Keep unread works: the button says what it does next, and the
  // article is unread on its list again.
  await keep.click();
  const markRead = top.getByRole('button', { name: 'Mark read' });
  await expect(markRead).toBeVisible();
  await markRead.click();
  await expect(keep).toBeVisible();
  await keep.click();
  await expect(markRead).toBeVisible();
  await letItSave(page);
  await page.getByRole('link', { name: 'Design', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Show read' })).not.toBeChecked();
  await expect(
    articles(page).getByRole('listitem').filter({ hasText: 'Three chairs' }),
  ).toHaveCount(1);
  await articles(page)
    .getByRole('link', { name: /Three chairs/ })
    .click();
  await expect(title).toBeVisible();
  await expect(keep).toBeVisible();

  // Reader mode works, and shows as pressed once the page's text is in.
  await readerMode.click();
  const body = page.locator('.body');
  await expect(body).toContainText('the full essay', { timeout: 30_000 });
  await expect(readerMode).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('article header .meta')).toContainText('Reader mode');
  await noSeriousViolations(page);
});

const ITEMS = `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}/feedItems`;

/**
 * `n` more unread articles in Design notes, past the rules as admin,
 * each a copy of Three chairs as the fetcher stored it (its stamp
 * included): "Kiln log 01" to "Kiln log <n>", on Tuesday, Nov 3, so
 * the list is long enough to scroll.
 */
async function seedKilnLogs(n: number): Promise<void> {
  const res = await fetch(`${ITEMS}?pageSize=300`, { headers: { authorization: 'Bearer owner' } });
  expect(res.ok).toBe(true);
  const { documents = [] } = (await res.json()) as {
    documents?: { fields: Record<string, { stringValue?: string }> }[];
  };
  const model = documents.find((d) => d.fields['title']?.stringValue === 'Three chairs');
  expect(model, 'Three chairs is stored').toBeDefined();
  for (let i = 1; i <= n; i++) {
    const nn = String(i).padStart(2, '0');
    const fields: Record<string, unknown> = { ...model!.fields };
    for (const name of ['readerState', 'readerContent', 'readerError', 'terms', 'readAt']) {
      delete fields[name];
    }
    Object.assign(fields, {
      title: { stringValue: `Kiln log ${nn}` },
      link: { stringValue: `https://design.invalid/kiln-${nn}` },
      summary: { stringValue: `Firing ${nn}: the cones, the shelves and what came out.` },
      content: { stringValue: `Firing ${nn}, written up.` },
      read: { booleanValue: false },
      saved: { booleanValue: false },
      published: {
        timestampValue: new Date(Date.UTC(2026, 10, 3, 12, 0) - i * 60_000).toISOString(),
      },
    });
    const put = await fetch(`${ITEMS}/kiln-${nn}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({ fields }),
    });
    expect(put.ok, `kiln-${nn}`).toBe(true);
  }
}

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Reader screens' });
const allTab = (page: Page) => tabs(page).getByRole('link', { name: /^All/ });
/** The folders column the panes had until 2026-11-22. */
const foldersColumn = (page: Page) =>
  page.getByRole('navigation', { name: 'Folders', exact: true });
const listPane = (page: Page) => page.getByRole('region', { name: 'List of articles' });
/** The list pane while it shows the Folders tab's folders (2026-11-22). */
const foldersInPane = (page: Page) => page.getByRole('region', { name: 'Folders', exact: true });
const articlePane = (page: Page) => page.getByRole('region', { name: 'Article', exact: true });
/** The list pane's own scroll box. */
const listBox = (page: Page) => listPane(page).locator('.pane-body');
const rowLink = (page: Page, id: string) => listPane(page).locator(`li[data-id="${id}"] a.open`);
/** The page does not scroll sideways. */
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/** Where a screenshot goes, when asked for one (READER_SHOTS, a directory). */
const shot = (name: string) =>
  process.env['READER_SHOTS'] ? `${process.env['READER_SHOTS']}/${name}` : undefined;

/**
 * A scroll box scrolled to its end: the gap from its last thing's foot
 * to its own, and whether its own foot is on the screen.
 */
async function footOf(
  box: Locator,
  last: string,
): Promise<{ gap: number; onScreen: boolean; scrolls: boolean }> {
  return box.evaluate((el, sel) => {
    el.scrollTop = el.scrollHeight;
    const end = [...el.querySelectorAll(sel)].at(-1)!.getBoundingClientRect().bottom;
    const own = el.getBoundingClientRect().bottom;
    return {
      gap: own - end,
      onScreen: own <= innerHeight + 0.5,
      scrolls: el.scrollHeight > el.clientHeight,
    };
  }, last);
}

/**
 * At the list pane's top, how far its first row's top is below its
 * first day's sticky heading: negative when the heading covers it.
 */
async function firstRowClear(page: Page): Promise<number> {
  return listBox(page).evaluate((box) => {
    box.scrollTop = 0;
    const head = box.querySelector('.day-head')!.getBoundingClientRect();
    const row = box.querySelector('li[data-id]')!.getBoundingClientRect();
    return row.top - head.bottom;
  });
}

test.describe('in two panes', () => {
  test.use({
    isMobile: false,
    hasTouch: false,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  test('list and article side by side; the list keeps its place', async ({ page }) => {
    test.setTimeout(120_000);
    await readerWithFixtures(page);
    await seedKilnLogs(30);
    await page.goto('/reader');

    // Two panes: no folders column; the tabs over the list, All current.
    await expect(foldersColumn(page)).toHaveCount(0);
    await expect(tabs(page).getByRole('link')).toHaveText(['All 35 unread', 'Saved', 'Folders']);
    await expect(allTab(page)).toHaveAttribute('aria-current', 'page');
    // No chips: the Folders tab stands for them.
    await expect(page.getByRole('navigation', { name: 'By folder' })).toHaveCount(0);
    await expect(articles(page).getByRole('listitem')).toHaveCount(35);
    await expect(articlePane(page)).toHaveText('Choose an article');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reader');
    // The header and tabs top the list's column; the article has the
    // window's height beside it, and the width the column gave up.
    const [t, l, a] = [
      (await tabs(page).boundingBox())!,
      (await listPane(page).boundingBox())!,
      (await articlePane(page).boundingBox())!,
    ];
    expect(t.y + t.height).toBeLessThanOrEqual(l.y);
    expect(t.x).toBeGreaterThanOrEqual(l.x - 0.5);
    expect(t.x + t.width).toBeLessThanOrEqual(l.x + l.width + 0.5);
    expect(l.x + l.width).toBeLessThanOrEqual(a.x + 1);
    expect(a.y).toBeLessThanOrEqual(t.y);
    expect(a.x + a.width).toBeLessThanOrEqual(1440 + 0.5);
    expect(a.width).toBeGreaterThan(l.width);
    // The page neither scrolls sideways nor down: the list pane does.
    expect(await noSidewaysScroll(page)).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= document.documentElement.clientHeight,
      ),
    ).toBe(true);
    // At its top, the first row is wholly below its day's heading.
    expect(await firstRowClear(page)).toBeGreaterThanOrEqual(-0.5);
    await noSeriousViolations(page);

    // Down the list, then a row well inside the pane opens beside it.
    await listBox(page).evaluate((box) => box.scrollTo(0, 700));
    const scrolled = await listBox(page).evaluate((box) => box.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    // A mark on the list's box: the same node afterwards is the same list, not drawn again.
    await listBox(page).evaluate((box) => box.setAttribute('data-kept', 'yes'));
    const ids = await listBox(page).evaluate((box) =>
      [...box.querySelectorAll<HTMLElement>('li[data-id]')].map((li) => li.dataset['id']!),
    );
    const pick = await listBox(page).evaluate((box) => {
      const pane = box.getBoundingClientRect();
      for (const li of box.querySelectorAll<HTMLElement>('li[data-id]')) {
        const r = li.getBoundingClientRect();
        if (r.top > pane.top + 160 && r.bottom < pane.bottom - 80) {
          return { id: li.dataset['id']!, title: li.querySelector('.title')!.textContent! };
        }
      }
      return undefined;
    });
    expect(pick, 'a row inside the pane').toBeDefined();
    const { id, title } = pick!;
    await rowLink(page, id).click();
    await expect(page).toHaveURL(new RegExp(`/reader/a/${id}\\?in=f(:|%3A)all$`));
    const heading = articlePane(page).getByRole('heading', { level: 2, name: title, exact: true });
    await expect(heading).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    // Its title has the focus, as a page arriving is read from the top.
    await expect(heading).toBeFocused();
    // With no ring: it was put there, not tabbed to (Eric, 2026-11-22).
    expect(await heading.evaluate((h) => getComputedStyle(h).outlineStyle)).toBe('none');
    // Its row is current, read and still there; the list kept its place.
    await expect(rowLink(page, id)).toHaveAttribute('aria-current', 'true');
    await expect(listPane(page).locator('a.open[aria-current]')).toHaveCount(1);
    await expect(listPane(page).locator(`li[data-id="${id}"]`)).toHaveClass(/\bread\b/);
    await expect(articles(page).getByRole('listitem')).toHaveCount(35);
    await expect(listBox(page)).toHaveAttribute('data-kept', 'yes');
    expect(await listBox(page).evaluate((box) => box.scrollTop)).toBe(scrolled);
    // Opened as before: marked read, All's count down by one.
    await expect(allTab(page)).toHaveText('All 34 unread');
    await noSeriousViolations(page);
    const two = shot('reader-two-panes.png');
    if (two) {
      // The list at its top for the picture, then where it was.
      await listBox(page).evaluate((box) => box.scrollTo(0, 0));
      await page.screenshot({ path: two });
      await listBox(page).evaluate((box, y) => box.scrollTo(0, y), scrolled);
    }

    // j and k move the article along the list shown, and its current row with it.
    const next = ids[ids.indexOf(id) + 1];
    await page.keyboard.press('j');
    await expect(page).toHaveURL(new RegExp(`/reader/a/${next}\\?`));
    // Opened by a key, the arriving title has the focus, with no ring:
    // it was put there, not tabbed to (Eric, 2026-11-22). By key, since
    // after a click the browser may show no ring whatever the rule.
    const nextHeading = articlePane(page).getByRole('heading', { level: 2 });
    await expect(nextHeading).not.toHaveText(title);
    await expect(nextHeading).toBeFocused();
    expect(await nextHeading.evaluate((h) => getComputedStyle(h).outlineStyle)).toBe('none');
    await expect(rowLink(page, next)).toHaveAttribute('aria-current', 'true');
    await expect(listPane(page).locator('a.open[aria-current]')).toHaveCount(1);
    await expect(articles(page).getByRole('listitem')).toHaveCount(35);
    await page.keyboard.press('k');
    await expect(page).toHaveURL(new RegExp(`/reader/a/${id}\\?`));
    await expect(heading).toBeVisible();
    await expect(rowLink(page, id)).toHaveAttribute('aria-current', 'true');
    await expect(listBox(page)).toHaveAttribute('data-kept', 'yes');

    // A reload of the article: the same two panes, its row current and in view.
    await letItSave(page);
    await page.reload();
    await expect(heading).toBeVisible();
    await expect(tabs(page).getByRole('link')).toHaveCount(3);
    await expect(foldersColumn(page)).toHaveCount(0);
    await expect(rowLink(page, id)).toHaveAttribute('aria-current', 'true');
    await expect(rowLink(page, id)).toBeInViewport();
    expect(await noSidewaysScroll(page)).toBe(true);
    await noSeriousViolations(page);
  });

  test('Folders in the list pane: a folder chosen is the list, the tab named for it', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await readerWithFixtures(page);
    await page.goto('/reader');
    await expect(articles(page).getByRole('listitem')).toHaveCount(5);

    // The Folders tab shows the folders where the list was, with their
    // unread; the article pane stays as it was.
    await tabs(page).getByRole('link', { name: 'Folders', exact: true }).click();
    await expect(page).toHaveURL(/\/reader\/folders$/);
    await expect(tabs(page).getByRole('link', { name: 'Folders', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const folders = foldersInPane(page).getByRole('navigation', { name: 'Folders' });
    await expect(folders.getByRole('link')).toHaveText(['Design 3 unread', 'Games 2 unread']);
    await expect(listPane(page)).toHaveCount(0);
    await expect(articlePane(page)).toHaveText('Choose an article');
    expect(await noSidewaysScroll(page)).toBe(true);
    await noSeriousViolations(page);
    const shotFolders = shot('reader-folders.png');
    if (shotFolders) await page.screenshot({ path: shotFolders });

    // A folder chosen there: its list in the pane, the tab named for it
    // and current, the list's heading focused, nothing open beside it.
    await folders.getByRole('link', { name: /^Games/ }).click();
    await expect(page).toHaveURL(/\/reader\/f\/Games$/);
    await expect(articles(page).getByRole('listitem')).toHaveCount(2);
    const gamesTab = tabs(page).getByRole('link', { name: 'Folders: Games', exact: true });
    await expect(gamesTab).toHaveAttribute('aria-current', 'true');
    await expect(gamesTab).toHaveText('Folders: Games');
    await expect(gamesTab.locator('.named')).toHaveText('Games');
    const listHeading = listPane(page).getByRole('heading', { name: 'Games', level: 2 });
    await expect(listHeading).toBeFocused();
    await expect(articlePane(page)).toHaveText('Choose an article');
    await noSeriousViolations(page);

    // The keys are the list's: j moves to a row, Enter opens it beside.
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/reader\/a\/.+\?in=f(:|%3A)Games$/);
    await expect(articlePane(page).getByRole('heading', { level: 2 })).toBeFocused();
    await expect(gamesTab).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/reader\/f\/Games$/);

    // Mark all read and Undo as ever, the status at the list pane's foot.
    await listPane(page).getByRole('button', { name: 'Mark all read' }).click();
    const status = listPane(page).getByRole('status');
    await expect(status).toContainText('marked read.');
    await expect(listPane(page).getByRole('button', { name: 'Undo' })).toBeFocused();
    const [s, pane] = [(await status.boundingBox())!, (await listPane(page).boundingBox())!];
    expect(s.x).toBeGreaterThanOrEqual(pane.x - 0.5);
    expect(s.x + s.width).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
    expect(Math.abs(s.y + s.height - (pane.y + pane.height))).toBeLessThanOrEqual(1);
    await listPane(page).getByRole('button', { name: 'Undo' }).click();
    await expect(status).toContainText('unread again.');

    // Back to the folders by the list's own link, and to All by its tab.
    await listPane(page).getByRole('link', { name: 'Folders', exact: true }).click();
    await expect(page).toHaveURL(/\/reader\/folders$/);
    await expect(folders).toBeVisible();
    await allTab(page).click();
    await expect(page).toHaveURL(/\/reader$/);
    // Everything but the one opened from Games, read as it opened.
    await expect(articles(page).getByRole('listitem')).toHaveCount(4);
    await expect(tabs(page).getByRole('link', { name: 'Folders', exact: true })).toBeVisible();
  });

  test('a row’s icons are the toolbar’s: named, with tooltips, and kept in step', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await readerWithFixtures(page);
    await page.goto('/reader/f/Design');
    const row = listPane(page).locator('li[data-id]').filter({ hasText: 'Three chairs' });
    const rowRead = row.getByRole('button', { name: 'Mark read: Three chairs', exact: true });
    const rowSave = row.getByRole('button', { name: 'Save for later: Three chairs', exact: true });
    // Icons, no words, each with its tooltip, side by side at the row's end.
    for (const [control, tip] of [
      [rowRead, 'Mark read'],
      [rowSave, 'Save for later'],
    ] as const) {
      await expect(control).toHaveAttribute('title', tip);
      await expect(control).toHaveText('');
      await expect(control.locator('svg')).toBeVisible();
    }
    await expect(rowSave).toHaveAttribute('aria-pressed', 'false');
    const [r, sv, text] = [
      (await rowRead.boundingBox())!,
      (await rowSave.boundingBox())!,
      (await row.locator('a.open').boundingBox())!,
    ];
    expect(Math.abs(r.y - sv.y)).toBeLessThanOrEqual(1);
    expect(r.x + r.width).toBeLessThanOrEqual(sv.x + 0.5);
    expect(text.x + text.width).toBeLessThanOrEqual(r.x + 0.5);
    // A keyboard reaches them, and the focus shows.
    await rowRead.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(rowRead).toBeFocused();
    expect(await rowRead.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');

    // Save from the row: pressed there, and in the article's toolbar.
    await rowSave.click();
    await expect(rowSave).toHaveAttribute('aria-pressed', 'true');
    await expect(rowSave).toHaveAttribute('title', 'Saved for later; press to unsave');
    await row.locator('a.open').click();
    const top = articlePane(page).locator('header.top');
    const barSave = top.getByRole('button', { name: 'Save for later', exact: true });
    await expect(barSave).toHaveAttribute('aria-pressed', 'true');
    await expect(barSave).toHaveAttribute('title', 'Saved for later; press to unsave');
    // Opened, so read: the row says Keep unread, as the toolbar does.
    const barKeep = top.getByRole('button', { name: 'Keep unread', exact: true });
    await expect(barKeep).toHaveAttribute('title', 'Keep unread');
    const rowKeep = row.getByRole('button', { name: 'Keep unread: Three chairs', exact: true });
    await expect(rowKeep).toHaveAttribute('title', 'Keep unread');
    // The same icon in both places.
    expect(await rowKeep.locator('svg').innerHTML()).toBe(await barKeep.locator('svg').innerHTML());
    expect(await rowSave.locator('svg').innerHTML()).toBe(await barSave.locator('svg').innerHTML());
    // Keep unread from the row: the toolbar follows; unsave from the toolbar: the row does.
    await rowKeep.click();
    await expect(top.getByRole('button', { name: 'Mark read', exact: true })).toBeVisible();
    await expect(rowRead).toBeVisible();
    await barSave.click();
    await expect(rowSave).toHaveAttribute('aria-pressed', 'false');
    // Every icon in the toolbar has a tooltip and a name.
    const icons = top.locator('.icon');
    expect(await icons.count()).toBeGreaterThanOrEqual(5);
    for (const icon of await icons.all()) {
      expect(await icon.getAttribute('title'), await icon.innerHTML()).toBeTruthy();
      expect(await icon.getAttribute('aria-label')).toBeTruthy();
    }
    // A day's Mark these read is a tick with its words for a name and a tooltip.
    const markThese = listPane(page).getByRole('button', { name: 'Mark these read' }).first();
    await expect(markThese).toHaveAttribute('title', /^Mark these read/);
    await expect(markThese).toHaveText('');
    await noSeriousViolations(page);
    // Closed, so the row is the list's again; after a reload it is as left.
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/reader\/f\/Design$/);
    await letItSave(page);
    await page.reload();
    await expect(rowRead).toBeVisible();
    await expect(rowSave).toHaveAttribute('aria-pressed', 'false');
  });

  test('each pane scrolls to its own end, nothing cut and no dead band', async ({ page }) => {
    test.setTimeout(120_000);
    await readerWithFixtures(page);
    await seedKilnLogs(30);
    for (const [n, width] of [1200, 1440].entries()) {
      await page.setViewportSize({ width, height: 900 });
      // The list: its last row clear of the status bar's room, on screen.
      await page.goto('/reader');
      // 35, or 34 once the first width has opened its article.
      await expect(articles(page).getByRole('listitem').nth(33)).toBeAttached();
      expect(await firstRowClear(page), `${width}: the first row`).toBeGreaterThanOrEqual(-0.5);
      const list = await footOf(listBox(page), 'li[data-id]');
      expect(list.onScreen, `${width}: the list's foot`).toBe(true);
      expect(list.gap, `${width}: the list's foot`).toBeGreaterThanOrEqual(8);
      expect(list.gap, `${width}: the list's foot`).toBeLessThanOrEqual(80);
      expect(list.scrolls, `${width}: the list scrolls`).toBe(true);
      // The article: down to Next and previous, on a window short enough
      // for even a fixture's article to scroll.
      // One article per width: the first, read once opened, has left All.
      await rowLink(page, `kiln-0${n + 1}`).click();
      await expect(articlePane(page).getByRole('heading', { level: 2 })).toHaveText(
        `Kiln log 0${n + 1}`,
      );
      await page.setViewportSize({ width, height: 260 });
      const article = await footOf(articlePane(page).locator('app-reader-article'), '.prevnext');
      expect(article.scrolls, `${width}: the article scrolls`).toBe(true);
      expect(article.onScreen, `${width}: the article's foot`).toBe(true);
      expect(article.gap, `${width}: the article's foot`).toBeGreaterThanOrEqual(8);
      expect(article.gap, `${width}: the article's foot`).toBeLessThanOrEqual(64);
      await page.setViewportSize({ width, height: 900 });
      // The folders: the last on screen.
      await page.goto('/reader/folders');
      await expect(foldersInPane(page).getByRole('link', { name: /^Games/ })).toBeVisible();
      const folders = await footOf(foldersInPane(page).locator('.pane-body'), 'nav li');
      expect(folders.onScreen, `${width}: the folders' foot`).toBe(true);
      expect(folders.gap, `${width}: the folders' foot`).toBeGreaterThanOrEqual(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollHeight <= document.documentElement.clientHeight,
        ),
        `${width}: the page itself does not scroll`,
      ).toBe(true);
    }
  });

  test('the list pane’s own scroll marks read; closing the article ends the run', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await readerWithFixtures(page);
    await seedKilnLogs(30);
    await openSettings(page, 'Modules');
    await page.getByRole('switch', { name: 'Mark articles read as I scroll past them' }).check();
    await letItSave(page);
    await page.goto('/reader');
    await expect(articles(page).getByRole('listitem')).toHaveCount(35);

    // A wheel over the list pane: its box scrolls, the page does not,
    // and the rows passed are marked in one batch and kept in the list.
    const pane = (await listPane(page).boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    await page.mouse.wheel(0, 1500);
    const marked = listPane(page)
      .getByRole('status')
      .filter({ hasText: /Marked \d+ read/ });
    await expect(marked).toBeVisible();
    const passed = Number(/Marked (\d+) read/.exec(await marked.innerText())![1]);
    expect(passed).toBeGreaterThan(0);
    expect(passed).toBeLessThan(35);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(articles(page).getByRole('listitem')).toHaveCount(35);
    await expect(allTab(page)).toHaveText(`All ${35 - passed} unread`);
    await listPane(page).getByRole('button', { name: 'Undo' }).click();
    await expect(listPane(page).getByRole('status')).toContainText(`${passed} unread again.`);
    await expect(allTab(page)).toHaveText('All 35 unread');
    // The count shows the undo at once, but its write is still on its
    // way to the persistent cache: a reload within milliseconds of the
    // click, quicker than any gardener's, lost it under load
    // (2026-11-17). The writes land first, as before any reload here.
    await letItSave(page);

    // An article opened stays in the list, read, while it is open;
    // Escape closes it, the run is over, and it leaves the list.
    await page.goto('/reader/f/Games');
    await expect(articles(page).getByRole('listitem')).toHaveCount(2);
    await articles(page)
      .getByRole('link', { name: /A one-page dungeon/ })
      .click();
    await expect(page).toHaveURL(/\/reader\/a\//);
    await expect(articlePane(page).getByRole('heading', { level: 2 })).toHaveText(
      'A one-page dungeon',
    );
    await expect(articles(page).getByRole('listitem')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/reader\/f\/Games$/);
    await expect(articlePane(page)).toHaveText('Choose an article');
    await expect(articles(page).getByRole('listitem')).toHaveCount(1);
  });

  test('no sideways page at its widths; under 1200 the Reader is as it was', async ({ page }) => {
    test.setTimeout(90_000);
    await readerWithFixtures(page);
    for (const width of [1200, 1320, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/reader/f/Design');
      await expect(listPane(page), `${width}`).toBeVisible();
      await expect(foldersColumn(page), `${width}`).toHaveCount(0);
      await expect(articles(page).getByRole('listitem'), `${width}`).toHaveCount(3);
      expect(await noSidewaysScroll(page), `${width}`).toBe(true);
      // The article's pane has room for its measure.
      expect((await articlePane(page).boundingBox())!.width, `${width}`).toBeGreaterThanOrEqual(
        592,
      );
    }
    // An article open in the panes; the window narrows past the width: the
    // article's own screen at the same address, and back.
    await articles(page)
      .getByRole('link', { name: /Three chairs/ })
      .click();
    await expect(
      articlePane(page).getByRole('heading', { name: 'Three chairs', level: 2 }),
    ).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.setViewportSize({ width: 1199, height: 900 });
    await expect(page.getByRole('heading', { name: 'Three chairs', level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/reader\/a\/.+\?in=f(:|%3A)Design$/);
    await expect(listPane(page)).toHaveCount(0);
    await expect(articles(page)).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(
      articlePane(page).getByRole('heading', { name: 'Three chairs', level: 2 }),
    ).toBeVisible();
    await expect(articles(page)).toHaveCount(1);

    // Folders too crosses the width: the screen of its own under it.
    await page.goto('/reader/folders');
    await expect(foldersInPane(page)).toBeVisible();
    await page.setViewportSize({ width: 1199, height: 900 });
    await expect(foldersInPane(page)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Folders', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/reader\/folders$/);

    // Just under the width: the list with its chips, and a row opens the
    // article in place of the list.
    await page.goto('/reader/f/Design');
    await expect(page.getByRole('navigation', { name: 'By folder' })).toBeVisible();
    await expect(listPane(page)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Article', exact: true })).toHaveCount(0);
    await articles(page)
      .getByRole('link', { name: /Celadon glazes/ })
      .click();
    await expect(page).toHaveURL(/\/reader\/a\//);
    await expect(page.getByRole('heading', { name: 'Celadon glazes', level: 1 })).toBeVisible();
    await expect(articles(page)).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);
  });
});

test('on a phone the Reader is as it was: a row opens the article full screen', async ({
  page,
}) => {
  await readerWithFixtures(page);
  await page.goto('/reader/f/Design');
  await expect(page.getByRole('navigation', { name: 'By folder' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Folders', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'List of articles' })).toHaveCount(0);
  await articles(page)
    .getByRole('link', { name: /Three chairs/ })
    .click();
  await expect(page).toHaveURL(/\/reader\/a\/.+\?in=f(:|%3A)Design$/);
  await expect(page.getByRole('heading', { name: 'Three chairs', level: 1 })).toBeVisible();
  await expect(articles(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Article', exact: true })).toHaveCount(0);
  await noSeriousViolations(page);
});

/** An article's stored text holding two tables, as the converter writes them (#313). */
const TABLES = [
  'A wide table first.',
  '',
  `| ${Array.from({ length: 8 }, (_, i) => `Heading ${i}`).join(' | ')} |`,
  `| ${Array.from({ length: 8 }, () => '---').join(' | ')} |`,
  `| ${Array.from({ length: 8 }, (_, i) => `unbreakablelongword${i}xxxxxxxx`).join(' | ')} |`,
  '',
  'Then one the page gave no header row.',
  '',
  '|  |  |',
  '| --- | --- |',
  '| left \\| words | right |',
].join('\n');

test('on a phone a wide table scrolls in its own box, not the page (#313, 2026-11-17)', async ({
  page,
}) => {
  await readerWithFixtures(page);
  // A copy of Three chairs as the fetcher stored it, its text the tables.
  const res = await fetch(`${ITEMS}?pageSize=300`, { headers: { authorization: 'Bearer owner' } });
  const { documents = [] } = (await res.json()) as {
    documents?: { fields: Record<string, { stringValue?: string }> }[];
  };
  const model = documents.find((d) => d.fields['title']?.stringValue === 'Three chairs');
  expect(model, 'Three chairs is stored').toBeDefined();
  const fields: Record<string, unknown> = { ...model!.fields };
  for (const name of ['readerState', 'readerContent', 'readerError', 'terms', 'readAt']) {
    delete fields[name];
  }
  Object.assign(fields, {
    title: { stringValue: 'Chair tables' },
    link: { stringValue: 'https://design.invalid/chair-tables' },
    summary: { stringValue: 'A wide table first.' },
    content: { stringValue: TABLES },
    read: { booleanValue: false },
  });
  const put = await fetch(`${ITEMS}/chair-tables`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({ fields }),
  });
  expect(put.ok).toBe(true);

  await page.goto('/reader/a/chair-tables?in=f:Design');
  await expect(page.getByRole('heading', { name: 'Chair tables', level: 1 })).toBeVisible();
  const [wide, headless] = [page.locator('.body table').nth(0), page.locator('.body table').nth(1)];
  await expect(wide).toBeVisible();
  await expect(wide.getByRole('columnheader', { name: 'Heading 7' })).toHaveCount(1);
  await expect(headless.getByRole('cell', { name: 'left | words' })).toBeVisible();
  // The page does not scroll sideways; the wide table does, in its box.
  expect(await noSidewaysScroll(page)).toBe(true);
  // Measured until it holds. The article was once drawn again when
  // opening it marked it read: a table taken just before that read
  // every width as 0, and one scrolled went back to its start. It is
  // drawn once per text now (2026-11-17), which the scroll below holds
  // to: it must stay where it was put.
  await expect(async () => {
    const box = await wide.evaluate((t) => ({
      scroll: t.scrollWidth,
      client: t.clientWidth,
      right: t.getBoundingClientRect().right,
    }));
    expect(box.client).toBeGreaterThan(0);
    expect(box.scroll).toBeGreaterThan(box.client);
    expect(box.right).toBeLessThanOrEqual(page.viewportSize()!.width);
  }).toPass({ timeout: 5000 });
  await wide.evaluate((t) => t.scrollTo({ left: 200 }));
  await expect.poll(() => wide.evaluate((t) => t.scrollLeft)).toBeGreaterThan(0);
  expect(await noSidewaysScroll(page)).toBe(true);
  // The empty header row the converter wrote is not drawn; the real one is.
  await expect(headless.locator('thead')).toBeHidden();
  await expect(wide.locator('thead')).toBeVisible();
  // It takes the focus, so the keys can scroll it too.
  await wide.focus();
  await expect(wide).toBeFocused();
  await noSeriousViolations(page);
});
