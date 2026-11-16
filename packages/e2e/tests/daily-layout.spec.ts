import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The layout pass, step 4 (#288): Right Now's rows have a round tick at
// the left and one snooze control at the right, so a reminder keeps to
// a line or two; Browse puts its search box first and its lenses in
// one row that scrolls inside itself, an empty lens left out; Home's
// hint is for someone new, and a tile with nothing in it is quieter.

/** Sixty characters, as a reminder Eric writes runs. */
const LONG = 'Ring the kiln shop about cone packs and two new shelf posts.';

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/**
 * Where a tap 21 px from the control's centre, across, down and on the
 * diagonals, does not land on it (as layout.spec.ts checks): none for
 * a 44 px target, its own box or an invisible area around it.
 */
async function missedTaps(control: Locator): Promise<string[]> {
  await control.scrollIntoViewIfNeeded();
  return control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    const missed: string[] = [];
    const points = [
      [0, 0],
      [-21, 0],
      [21, 0],
      [0, -21],
      [0, 21],
      [-14, -14],
      [14, -14],
      [-14, 14],
      [14, 14],
    ] as const;
    for (const [dx, dy] of points) {
      const hit = document.elementFromPoint(x + dx, y + dy);
      if (!hit || !el.contains(hit)) missed.push(`${dx},${dy}: ${hit?.outerHTML.slice(0, 60)}`);
    }
    return missed;
  });
}

/**
 * The WCAG contrast of an element's text on a background, from their
 * computed colours (`rgb(...)`, the themes' tokens being opaque).
 */
async function contrastOn(text: Locator, background: Locator): Promise<number> {
  const colours = [
    await text.evaluate((el) => getComputedStyle(el).color),
    await background.evaluate((el) => getComputedStyle(el).backgroundColor),
  ];
  const [fg, bg] = colours.map((c) => {
    const [r, g, b] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => Number(v) / 255);
    const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  });
  const [hi, lo] = [fg, bg].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 412, height: 839 } });

  test('a Right Now row keeps a long reminder to two lines, its tick left and its snooze right', async ({
    page,
  }) => {
    expect(LONG).toHaveLength(60);
    await signInAs(page, OWNER);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const call = await connectClaude(page);
    await call('create_reminder', {
      text: LONG,
      dueAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    await call('create_reminder', {
      text: 'Call the bank',
      dueAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    await call('create_reminder', { text: 'Learn the banjo' });

    await page.goto('/right-now');
    const overdue = page.getByRole('region', { name: 'Overdue' });
    const row = overdue.getByRole('listitem').filter({ hasText: LONG });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // The Overdue heading says so in words, and in a tint Someday's lacks.
    const heading = page.getByRole('heading', { name: 'Overdue', level: 2 });
    await expect(heading).toBeVisible();
    const someday = page.getByRole('heading', { name: 'Someday', level: 2 });
    const colour = (h: Locator) => h.evaluate((el) => getComputedStyle(el).color);
    expect(await colour(heading)).not.toBe(await colour(someday));

    // Two controls on the row: the tick at the left, one snooze at the right.
    const done = row.getByRole('button', { name: `Done: ${LONG}` });
    const snooze = row.getByRole('button', { name: `Snooze: ${LONG}` });
    await expect(row.getByRole('button')).toHaveCount(2);
    const text = row.locator('.text');
    const [doneBox, snoozeBox, textBox] = await Promise.all(
      [done, snooze, text].map(async (l) => (await l.boundingBox())!),
    );
    expect(doneBox.x + doneBox.width).toBeLessThanOrEqual(textBox.x);
    expect(snoozeBox.x).toBeGreaterThanOrEqual(textBox.x + textBox.width);
    // The text's own line boxes: one or two (no line-height to trust).
    const lines = await text.evaluate((el) => el.getClientRects().length);
    expect(lines).toBeGreaterThanOrEqual(1);
    expect(lines).toBeLessThanOrEqual(2);
    expect(await missedTaps(done)).toEqual([]);
    expect(await missedTaps(snooze)).toEqual([]);
    await noSeriousViolations(page);

    // Done takes a row away.
    await overdue.getByRole('button', { name: 'Done: Call the bank' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Call the bank' })).toHaveCount(0);

    // Snooze opens its choices; one moves the reminder out of Overdue, and Undo puts it back.
    await expect(snooze).toHaveAttribute('aria-expanded', 'false');
    await snooze.click();
    await expect(snooze).toHaveAttribute('aria-expanded', 'true');
    const choices = page.getByRole('group', { name: `Snooze ${LONG} until` });
    await expect(choices.getByRole('button', { name: 'In an hour' })).toBeVisible();
    await expect(choices.getByRole('button', { name: 'Tomorrow' })).toBeVisible();
    await noSeriousViolations(page);
    await choices.getByRole('button', { name: 'In an hour' }).click();
    await expect(overdue).toHaveCount(0);
    const main = page.getByRole('main');
    await expect(main.getByRole('status').filter({ hasText: 'Snoozed' })).toBeVisible();
    await main.getByRole('button', { name: 'Undo' }).click();
    await expect(overdue.getByRole('listitem').filter({ hasText: LONG })).toBeVisible();
  });
});

test.describe('on a narrow phone', () => {
  test.use({ viewport: { width: 320, height: 700 } });

  test('Browse puts the search box first and its lenses in one row that scrolls inside itself', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    await call('create_note', { body: 'Glaze test\nCeladon over the bisque' });
    await call('create_note', { body: 'Seed order\nShino and tenmoku' });
    const { id: old } = (await call('create_note', { body: 'Old kiln log\nCone 6' })) as {
      id: string;
    };
    await call('archive_note', { id: old });
    await call('create_concept', { name: 'Kiln build', type: 'project' });

    // Journal is empty, and open: it stays in the row, in sight.
    await page.goto('/browse/journal');
    const lenses = page.getByRole('navigation', { name: 'Lenses' });
    await expect(lenses.getByRole('link', { name: /^Archived/ })).toBeVisible({ timeout: 15_000 });
    const journal = lenses.getByRole('link', { name: /^Journal/ });
    await expect(journal).toHaveAttribute('aria-current', 'page');
    await expect(journal).toBeInViewport();
    // People has nothing: it is left out.
    await expect(lenses.getByRole('link', { name: /^People/ })).toHaveCount(0);
    await expect(lenses.getByRole('link', { name: /^Trash/ })).toHaveCount(0);

    // The search box comes first, above the lenses.
    const search = page.getByRole('searchbox', { name: 'Search notes' });
    const searchBox = (await search.boundingBox())!;
    const rowBox = (await lenses.boundingBox())!;
    expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(rowBox.y + 1);

    // One row: every chip shares a top.
    const tops = await lenses
      .getByRole('link')
      .evaluateAll((links) => links.map((a) => Math.round(a.getBoundingClientRect().top)));
    expect(tops.length).toBeGreaterThanOrEqual(5);
    expect(new Set(tops).size).toBe(1);

    // It scrolls inside itself, and the page never sideways.
    const row = await lenses.evaluate((nav) => {
      const before = nav.scrollLeft;
      nav.scrollLeft = before === 0 ? 60 : 0;
      return {
        overflowX: getComputedStyle(nav).overflowX,
        wider: nav.scrollWidth > nav.clientWidth,
        moved: nav.scrollLeft !== before,
        pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        windowX: window.scrollX,
      };
    });
    expect(['auto', 'scroll']).toContain(row.overflowX);
    expect(row.wider).toBe(true);
    expect(row.moved).toBe(true);
    expect(row.pageScroll).toBeLessThanOrEqual(0);
    expect(row.windowX).toBe(0);
    await noSeriousViolations(page);

    // A search narrows the list.
    await lenses.getByRole('link', { name: /^Recent/ }).click();
    await expect(page).toHaveURL(/\/browse$/);
    const notes = page.getByRole('list', { name: 'Notes' });
    await expect(notes).toContainText('Seed order', { timeout: 15_000 });
    await expect(notes).toContainText('Glaze test');
    await search.fill('celadon');
    await expect(notes.getByRole('listitem')).toHaveCount(1);
    await expect(notes).toContainText('Glaze test');
    await expect(notes).not.toContainText('Seed order');
    expect(await missedTaps(lenses.getByRole('link').first())).toEqual([]);
    await noSeriousViolations(page);
  });
});

test('Home’s hint is for someone new, and a tile with nothing in it is quieter', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  const call = await connectClaude(page);
  await page.goto('/home');
  const hint = page.getByText('Tap the box to write; it opens the editor.');
  // A new account's notes are known at the server's first answer.
  await expect(hint).toBeVisible({ timeout: 20_000 });
  await noSeriousViolations(page);

  for (const n of [1, 2, 3, 4, 5]) await call('create_note', { body: `Note ${n}\nA line` });
  const tiles = page.getByRole('navigation', { name: 'Modules' });
  const notesTile = tiles.getByRole('link', { name: /^Notes/ });
  await expect(notesTile).toContainText('5 ·', { timeout: 20_000 });
  await expect(hint).toHaveCount(0);

  // Five notes against nothing waiting: the empty line is the dimmer.
  const reading = tiles.getByRole('link', { name: /^Reading queue/ });
  await expect(reading).toContainText('Nothing waiting');
  const full = await contrastOn(notesTile.locator('.status'), notesTile);
  const empty = await contrastOn(reading.locator('.status'), reading);
  expect(empty).toBeLessThan(full);
  // Both still read: AA for text.
  expect(empty).toBeGreaterThanOrEqual(4.5);
  await noSeriousViolations(page);
});
