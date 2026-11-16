import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { serveEpisodes } from '../src/episodes';
import { expect, letItSave, signInAs, switchModulesOn, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Podcasts, step 6 of the layout pass (#290, epic #282): an episode's
// row is its artwork as Play, its title in at most two lines, the
// length on a line with other words, and one queue button; the
// episode's page has a full-width Position slider with its times at
// its ends and round controls; the mini-player's controls are round
// icon buttons with a drawn line along its top; and a show's page
// keeps its feed's address under About this show. The two fixture
// shows are Kiln hour and Glaze lab (stand-in.emulator.ts), Glaze lab
// with no artwork, so its rows draw its initials.

test.use({ viewport: { width: 412, height: 839 } });

const FEED = 'https://feeds.invalid/pod.xml';
const SHOW = 'Kiln hour (fixture)';
const FEED2 = 'https://feeds.invalid/glaze.xml';
const SHOW2 = 'Glaze lab (fixture)';
/** Each fixture episode's length as its row says it, before any is played. */
const LENGTHS: Record<string, string> = {
  'Reduction firing': '42 min',
  'Wedging clay': '1 h 05 min',
  'Testing tiles': '31 min',
  'Crawling and pinholes': '38 min',
};

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Where a tap 21 px from the control's centre misses it (as layout.spec.ts). */
async function missedTaps(control: Locator): Promise<string[]> {
  await control.scrollIntoViewIfNeeded();
  return control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    const missed: string[] = [];
    // 14 on the diagonals, still inside a round control 44 px across.
    for (const [dx, dy] of [
      [0, 0],
      [-21, 0],
      [21, 0],
      [0, -21],
      [0, 21],
      [-14, -14],
      [14, -14],
      [-14, 14],
      [14, 14],
    ] as const) {
      const hit = document.elementFromPoint(x + dx, y + dy);
      if (!hit || !el.contains(hit)) missed.push(`${dx},${dy}: ${hit?.outerHTML.slice(0, 60)}`);
    }
    return missed;
  });
}

/** What `--mini-player-height` comes to on the page, in px: 0 while unset. */
const miniHeight = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.height = 'var(--mini-player-height, 0px)';
    document.body.append(probe);
    const px = probe.getBoundingClientRect().height;
    probe.remove();
    return px;
  });

/** Podcasts on, both fixture shows followed and looked at. */
async function twoShows(page: Page): Promise<void> {
  await serveEpisodes(page);
  await signInAs(page, OWNER);
  await switchModulesOn(page, 'Podcasts');
  for (const [feed, show] of [
    [FEED, SHOW],
    [FEED2, SHOW2],
  ]) {
    await page.goto('/podcasts/add');
    await page.getByRole('textbox', { name: "The show's feed, or its site" }).fill(feed);
    await expect(page.getByRole('button', { name: 'Find the feed' })).toBeEnabled();
    await page.getByRole('button', { name: 'Find the feed' }).click();
    await expect(page.getByRole('radiogroup', { name: 'Feeds found' })).toContainText(show, {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: `Follow ${show}` }).click();
    await expect(page.getByRole('status')).toContainText(`Following ${show}.`);
    await letItSave(page);
  }
  await page.goto('/podcasts/shows');
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('4 new articles', { timeout: 30_000 });
}

const rows = (page: Page) => page.getByRole('list', { name: 'Episodes' }).getByRole('listitem');

/**
 * Whether the words of `length` in the row's meta line sit on one line
 * with at least one other word (not a bare "·"), measured word by word
 * with ranges, whatever the line height.
 */
const lengthSharesLine = (row: Locator, length: string) =>
  row.locator('.meta').evaluate((meta, length) => {
    const text = meta.textContent ?? '';
    const at = text.lastIndexOf(length);
    if (at < 0) return `no "${length}" in "${text}"`;
    const words: { word: string; mine: boolean; top: number }[] = [];
    const walker = document.createTreeWalker(meta, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const s = node.textContent ?? '';
      for (const m of s.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const rect = range.getClientRects()[0];
        const start = offset + m.index;
        if (rect)
          words.push({
            word: m[0],
            mine: start >= at && start < at + length.length,
            top: Math.round(rect.top + rect.height / 2),
          });
      }
      offset += s.length;
    }
    const mine = new Set(words.filter((w) => w.mine).map((w) => w.top));
    if (mine.size !== 1) return `"${length}" is broken over ${mine.size} lines`;
    const [line] = [...mine];
    const others = words.filter((w) => !w.mine && w.word !== '·' && Math.abs(w.top - line) < 4);
    return others.length ? 'shared' : `"${length}" is on a line of its own`;
  }, length);

test('Latest’s rows, and the mini-player’s controls, at 412 px', async ({ page }) => {
  test.setTimeout(120_000);
  await twoShows(page);
  await page.goto('/podcasts');
  await expect(rows(page)).toHaveCount(4);
  // All, so the row stays put once it is Started.
  await page
    .getByRole('group', { name: 'Which episodes' })
    .getByRole('button', { name: /^All/ })
    .click();
  await expect(rows(page)).toHaveCount(4);

  for (const row of await rows(page).all()) {
    const title = (await row.locator('.title').textContent())!.trim();
    // The title in at most two lines: under three font sizes tall.
    const lines = await row
      .locator('.title')
      .evaluate(
        (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).fontSize),
      );
    expect(lines, `${title}: its title`).toBeLessThan(3);
    // The length on a line that holds other words too.
    expect(await lengthSharesLine(row, LENGTHS[title]), title).toBe('shared');
    // Two buttons: Play on the artwork, and the queue.
    const buttons = row.getByRole('button');
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toHaveAccessibleName(`Play ${title}`);
    await expect(buttons.nth(1)).toHaveAccessibleName(`Add ${title} to the queue`);
    expect(await missedTaps(buttons.nth(0)), `${title}: Play`).toEqual([]);
    expect(await missedTaps(buttons.nth(1)), `${title}: the queue`).toEqual([]);
    // The artwork is inside Play: a picture or the show's initials.
    const art = buttons.nth(0).locator('app-episode-art');
    await expect(art).toHaveCount(1);
    // And the text still opens the episode.
    await expect(row.getByRole('link', { name: new RegExp(title) })).toHaveAttribute(
      'href',
      /^\/podcasts\/e\//,
    );
  }
  // Glaze lab has no artwork: its rows draw its initials, hidden from readers.
  const tiles = rows(page).filter({ hasText: 'Testing tiles' });
  await expect(tiles.locator('.square')).toHaveText('GL');
  await expect(tiles.locator('.square')).toHaveAttribute('aria-hidden', 'true');
  await noSeriousViolations(page);

  // The artwork plays: Pause on it, and the mini-player shows.
  await expect.poll(() => miniHeight(page)).toBe(0);
  const firing = rows(page).filter({ hasText: 'Reduction firing' });
  await firing.getByRole('button', { name: 'Play Reduction firing', exact: true }).click();
  const bar = page.getByRole('complementary', { name: 'Now playing' });
  await expect(bar).toContainText('Reduction firing');
  await expect(
    firing.getByRole('button', { name: 'Pause Reduction firing', exact: true }),
  ).toBeVisible();
  await bar.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(bar.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  // The mini-player: each control named as before, a 44 px tap each.
  const controls = bar.locator('.controls').getByRole('button');
  await expect(controls).toHaveCount(4);
  for (const [i, name] of [
    'Back 15 seconds',
    'Play',
    'Forward 30 seconds',
    'Close the player',
  ].entries()) {
    await expect(controls.nth(i)).toHaveAccessibleName(name);
    expect(await missedTaps(controls.nth(i)), name).toEqual([]);
  }
  // Its artwork is never a broken image: Kiln hour's episodes' own
  // are refused, so the show's initials stand in, as in the rows.
  await expect
    .poll(() =>
      bar
        .locator('img')
        .evaluateAll((imgs) =>
          imgs.filter((i) => !(i as HTMLImageElement).naturalWidth).map((i) => i.outerHTML),
        ),
    )
    .toEqual([]);
  await expect(bar.locator('app-episode-art')).toHaveCount(1);
  // Its line along the top edge, drawn only; the time is in words.
  const line = bar.locator('.progress');
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAttribute('role', 'presentation');
  expect((await line.boundingBox())!.height).toBe(2);
  await expect(bar).toContainText(/\d+:\d\d \/ \d+:\d\d/);
  // Room left for it while it shows.
  await expect.poll(() => miniHeight(page)).toBeGreaterThanOrEqual(64);
  await noSeriousViolations(page);

  // Its title opens the episode, where it yields to the page's player.
  await bar.getByRole('link', { name: 'Open the episode: Reduction firing' }).click();
  await expect(page).toHaveURL(/\/podcasts\/e\//);
  await expect(bar).toHaveCount(0);
  await expect.poll(() => miniHeight(page)).toBe(0);
  await page.getByRole('link', { name: 'Latest', exact: true }).click();
  await expect(bar).toBeVisible();
  await expect.poll(() => miniHeight(page)).toBeGreaterThanOrEqual(64);

  // Closed: gone, and the room with it.
  await bar.getByRole('button', { name: 'Close the player' }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(() => miniHeight(page)).toBe(0);
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--mini-player-height'),
    ),
  ).toBe('');
});

test('the episode’s player, and About this show, at 412 px', async ({ page }) => {
  test.setTimeout(120_000);
  await twoShows(page);
  await page.goto('/podcasts');
  await rows(page)
    .getByRole('link', { name: /Reduction firing/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Reduction firing', level: 1 })).toBeVisible();
  const player = page.getByRole('region', { name: 'Player' });

  // Play: big and round, the accent's filled button.
  const play = player.getByRole('button', { name: 'Play', exact: true });
  const round = (control: Locator) =>
    control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const radius = getComputedStyle(el).borderTopLeftRadius;
      const px = radius.endsWith('%') ? (parseFloat(radius) / 100) * r.width : parseFloat(radius);
      return { width: r.width, height: r.height, round: px >= r.width / 2 - 0.5 };
    });
  const p = await round(play);
  expect(p.width).toBeGreaterThanOrEqual(56);
  expect(p.height).toBeGreaterThanOrEqual(56);
  expect(p.round).toBe(true);
  for (const name of ['Back 15 seconds', 'Forward 30 seconds']) {
    const skip = await round(player.getByRole('button', { name, exact: true }));
    expect(skip.width, name).toBeGreaterThanOrEqual(44);
    expect(skip.height, name).toBeGreaterThanOrEqual(44);
    expect(skip.round, name).toBe(true);
  }
  for (const name of ['Back 15 seconds', 'Play', 'Forward 30 seconds', 'Speed 1×']) {
    expect(await missedTaps(player.getByRole('button', { name, exact: true })), name).toEqual([]);
  }

  // The slider: at least 80% of the page's content width, its times at its ends.
  const slider = player.getByRole('slider', { name: 'Position' });
  await expect(slider).toHaveAttribute('aria-valuetext', '0:00 of 42:10');
  const [track, content] = [
    (await slider.boundingBox())!,
    (await page.locator('main article').boundingBox())!,
  ];
  expect(track.width).toBeGreaterThanOrEqual(content.width * 0.8);
  const elapsed = player.locator('.times .elapsed');
  const total = player.locator('.times .total');
  await expect(elapsed).toHaveText('0:00');
  await expect(total).toHaveText('42:10');
  const [left, right] = [(await elapsed.boundingBox())!, (await total.boundingBox())!];
  expect(Math.abs(left.x - track.x)).toBeLessThan(12);
  expect(Math.abs(right.x + right.width - (track.x + track.width))).toBeLessThan(12);
  expect(left.y).toBeGreaterThan(track.y);

  // The keyboard still moves it, a second a press.
  await slider.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', /^0:0[1-5] of /);
  await expect(elapsed).not.toHaveText('0:00');
  await noSeriousViolations(page);

  // A show's page: the address only once About this show is opened.
  await page.goto('/podcasts/shows');
  await page.getByRole('list', { name: 'Shows' }).getByRole('link', { name: SHOW }).click();
  await expect(page.getByRole('heading', { name: SHOW, level: 1 })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  for (const row of await rows(page).all()) await expect(row.getByRole('button')).toHaveCount(2);
  const address = page.getByText(FEED, { exact: true });
  await expect(address).toBeHidden();
  const copy = page.getByRole('button', { name: 'Copy address' });
  await expect(copy).toBeHidden();
  await noSeriousViolations(page);
  await page.locator('summary', { hasText: 'About this show' }).click();
  await expect(address).toBeVisible();
  await expect(copy).toBeVisible();
  // Below the episodes, not under the name.
  const [list, about] = [
    (await page.getByRole('list', { name: 'Episodes' }).boundingBox())!,
    (await address.boundingBox())!,
  ];
  expect(about.y).toBeGreaterThan(list.y + list.height);
  await copy.click();
  await expect(page.getByRole('status')).toContainText(/Address copied\.|Could not copy/);
  await noSeriousViolations(page);
});
