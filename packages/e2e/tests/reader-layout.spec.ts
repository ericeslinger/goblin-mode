import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, letItSave, signInAs, test } from '../src/fixtures';
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
  await page.goto('/settings');
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

const articles = (page: Page) => page.getByRole('list', { name: 'Articles' });
const dayHeading = (page: Page, name: string) =>
  articles(page).getByRole('heading', { level: 3, name, exact: true });
/** A day's own Mark these read, beside its heading. */
const markDay = (page: Page, name: string) =>
  articles(page)
    .locator('.day')
    // Relative to the day itself: a locator rooted at the list finds nothing inside it.
    .filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) })
    .getByRole('button', { name: 'Mark these read' });

test('the list by day: headings with counts, one day marked read, and Undo', async ({ page }) => {
  await readerWithFixtures(page);
  await page.goto('/reader');
  const rows = articles(page).getByRole('listitem');
  // Each day's heading is in its first article's item: five items, five articles.
  await expect(rows).toHaveCount(5);
  await expect(articles(page).locator('.row')).toHaveCount(5);
  await expect(articles(page).getByRole('heading', { level: 3 })).toHaveCount(4);
  await expect(dayHeading(page, 'Today, 2 unread')).toBeVisible();
  await expect(dayHeading(page, 'Yesterday, 1 unread')).toBeVisible();
  await expect(dayHeading(page, 'Wednesday, Nov 4, 1 unread')).toBeVisible();
  await expect(dayHeading(page, 'Monday, Nov 2, 1 unread')).toBeVisible();
  // On screen the count follows a dot.
  await expect(articles(page).locator('.day').first()).toContainText('Today · 2');
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

  // The day being read stays at the top while its rows scroll: a bar
  // standing for its heading, there only once the heading has gone up.
  await page.setViewportSize({ width: 412, height: 420 });
  const bar = page.locator('.current-day .bar');
  await expect(bar).toHaveCount(0);
  const scrollPast = (n: number) =>
    page.evaluate((at) => {
      const head = document.querySelectorAll('ul[aria-label="Articles"] .day')[at]!;
      window.scrollTo(0, window.scrollY + head.getBoundingClientRect().top + 60);
    }, n);
  await scrollPast(0);
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Today · 2');
  await expect.poll(async () => Math.round((await bar.boundingBox())!.y)).toBe(0);
  // Hidden from screen readers: the heading in the list is the one they read.
  await expect(page.locator('.current-day')).toHaveAttribute('aria-hidden', 'true');
  await scrollPast(1);
  await expect(bar).toContainText('Yesterday · 1');
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
  await page.getByRole('checkbox', { name: 'Show read' }).check();
  await expect(rows).toHaveCount(5);
  await expect(dayHeading(page, 'Yesterday')).toBeVisible();
  await expect(
    articles(page)
      .locator('.day')
      .filter({ has: dayHeading(page, 'Yesterday') })
      .getByRole('button'),
  ).toHaveCount(0);

  // Mark all read stays at the top, and has the same Undo.
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('status')).toContainText('4 marked read.');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toContainText('4 unread again.');
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
  // The rows themselves; a day's first item also holds its heading.
  const heights = async () =>
    (
      await articles(page)
        .locator('.row')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    ).map(Math.round);
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
