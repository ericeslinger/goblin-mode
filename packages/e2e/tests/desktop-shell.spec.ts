import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { type CallTool, connectClaude } from '../src/claude';
import {
  expect,
  letItSave,
  openCapture,
  openMore,
  openRightNow,
  signInAs,
  switchModulesOn,
  test,
} from '../src/fixtures';
import { OWNER } from '../src/personas';

// The desktop shell, its first part (#289, epic #282; Eric, 2026-11-15):
// from 900 px a rail of the garden's places on every screen, with
// their counts, Right Now one of them; and the note at a reading
// measure. Its second (2026-11-16): from 1400 px a saved note's back
// kept open as a column beside its text. From 641 to 899 px
// (2026-11-16) the rail is icons alone beside the phone's layout;
// under 641 px nothing changes. Since 2026-11-22 a menu button at the
// rail's top switches it between names and icons at any of its widths.

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'Places', exact: true });
/** The rail's menu button (2026-11-22), named for what it will do. */
const menuButton = (page: Page) =>
  rail(page).getByRole('button', { name: /^(Collapse|Expand) navigation$/ });
/** An entry by its name, whatever its count says after it. */
const entry = (page: Page, name: string) =>
  rail(page).getByRole('link', { name: new RegExp(`^${name}(,|$)`) });
/** The name of the entry marked as the current page. */
const currentName = (page: Page) =>
  rail(page).locator('a[aria-current="page"] .name').allTextContents();
/** The routed screen: the element the router draws after its outlet. */
const screen = (page: Page) => page.locator('app-root > router-outlet + *');
/**
 * The left edge of the screen's content: its own box and its top-level
 * parts', whichever is furthest left (a custom element is inline, so
 * its children say where the page is).
 */
const contentLeft = (page: Page) =>
  screen(page).evaluate((host) =>
    Math.min(
      ...[host, ...host.children]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => r.left),
    ),
  );

/**
 * The text's column is about 70 characters, measured in the editor's
 * own "0": no wider than 75 of them, and not cramped either.
 */
async function expectReadingMeasure(editor: Locator): Promise<void> {
  const measure = await editor.evaluate((content) => {
    const line = content.querySelector('.cm-line')!;
    const style = getComputedStyle(line);
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(75);
    Object.assign(probe.style, {
      position: 'absolute',
      visibility: 'hidden',
      whiteSpace: 'pre',
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
    });
    document.body.appendChild(probe);
    const seventyFive = probe.getBoundingClientRect().width;
    probe.remove();
    return { line: line.getBoundingClientRect().width, seventyFive };
  });
  expect(measure.line).toBeLessThanOrEqual(measure.seventyFive);
  expect(measure.line).toBeGreaterThan((measure.seventyFive * 55) / 75);
}

/** The page does not scroll sideways. */
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

const LONG =
  'The kiln shelves want a fresh coat of wash before the next glaze firing, and the cone ' +
  'packs for the top and bottom need moving to the spy holes, so the readings at cone six ' +
  'are taken where the heat actually is and not where it is easiest to look. '.repeat(3);

/** Kitchen, the Reader and Podcasts on, as other journeys switch them. */
async function modulesOn(page: Page): Promise<void> {
  // Podcasts follows the Reader until it is switched itself (#245): the
  // helper waits for it to come on with the Reader, never clicking it as
  // it turns on, which could turn it off again.
  await switchModulesOn(page, 'Reader', 'Podcasts', 'Kitchen');
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Kitchen' })).toBeChecked();
}

async function aNote(call: CallTool, body: string): Promise<string> {
  return ((await call('create_note', { body })) as { id: string }).id;
}

/** The screens with the rail, where each lands, and the entry it marks. */
function screens(id: string): [url: string, lands: RegExp, current: string][] {
  return [
    ['/home', /\/home$/, 'Home'],
    [`/n/${id}`, new RegExp(`/n/${id}$`), 'Notes'],
    ['/browse', /\/browse/, 'Notes'],
    ['/right-now', /\/right-now$/, 'Right Now'],
    ['/settings', /\/settings$/, 'Settings'],
    ['/settings/modules', /\/settings\/modules$/, 'Settings'],
    ['/map', /\/map$/, 'Map'],
    ['/kitchen', /\/n\/meals-\d{4}-\d{2}-\d{2}$/, 'Kitchen'],
    ['/kitchen/recipes', /\/kitchen\/recipes$/, 'Kitchen'],
    ['/reader', /\/reader$/, 'Reader'],
    ['/podcasts', /\/podcasts$/, 'Podcasts'],
    ['/reading', /\/reading$/, 'Reading queue'],
    ['/activity', /\/activity$/, 'Assistants'],
  ];
}

/** The rail's width: 176 px with names from 900, 64 px of icons under it. */
const RAIL_WIDTH = { full: [132, 180], icons: [56, 64] } as const;

for (const { viewport, icons } of [
  { viewport: { width: 1440, height: 900 }, icons: false },
  { viewport: { width: 900, height: 700 }, icons: false },
  // A tablet upright (2026-11-16): the same rail, as icons.
  { viewport: { width: 768, height: 1024 }, icons: true },
]) {
  const [narrowest, widest] = RAIL_WIDTH[icons ? 'icons' : 'full'];
  test.describe(`at ${viewport.width} by ${viewport.height}`, () => {
    test.use({ isMobile: false, hasTouch: false, viewport });

    test('the rail is on every screen, in one place, its entry current, nothing under it', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await signInAs(page, OWNER);
      const call = await connectClaude(page);
      const id = await aNote(call, 'Studio day\nclay');
      await modulesOn(page);

      let first: { x: number; width: number } | undefined;
      for (const [url, lands, current] of screens(id)) {
        await page.goto(url);
        await expect(page).toHaveURL(lands, { timeout: 15_000 });
        await expect(rail(page)).toBeVisible();
        await expect.poll(() => currentName(page), { message: url }).toEqual([current]);
        const box = (await rail(page).boundingBox())!;
        first ??= { x: box.x, width: box.width };
        expect([url, box.x, box.width]).toEqual([url, first.x, first.width]);
        expect(box.x).toBe(0);
        expect(box.width).toBeGreaterThanOrEqual(narrowest);
        expect(box.width).toBeLessThanOrEqual(widest);
        // The page beside it, never under it, and no sideways scroll.
        expect(await contentLeft(page), url).toBeGreaterThanOrEqual(box.x + box.width - 0.5);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
          url,
        ).toBe(true);
      }

      // In order, Settings at the foot, each a mouse's height at least.
      // A fresh page load draws the rail before the modules' settings
      // are read, as Home's tiles are: the switched-on ones join it then.
      await expect(rail(page).locator('a .name')).toHaveText([
        'Home',
        'Notes',
        'Right Now',
        'Kitchen',
        'Reader',
        'Podcasts',
        'Reading queue',
        'Map',
        'Assistants',
        'Settings',
      ]);
      // Icons alone are touch targets, 44 px each way, inside the strip.
      for (const link of await rail(page).getByRole('link').all()) {
        const box = (await link.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(icons ? 44 : 36);
        if (icons) {
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.x + box.width).toBeLessThanOrEqual(widest);
        }
      }
      const settings = (await entry(page, 'Settings').boundingBox())!;
      const assistants = (await entry(page, 'Assistants').boundingBox())!;
      expect(settings.y).toBeGreaterThan(assistants.y + assistants.height);
    });

    test('each entry opens its screen', async ({ page }) => {
      test.setTimeout(90_000);
      await signInAs(page, OWNER);
      await modulesOn(page);
      await page.goto('/home');
      const lands: [name: string, url: RegExp][] = [
        ['Notes', /\/browse$/],
        ['Right Now', /\/right-now$/],
        ['Kitchen', /\/n\/meals-\d{4}-\d{2}-\d{2}$/],
        ['Reader', /\/reader$/],
        ['Podcasts', /\/podcasts$/],
        ['Reading queue', /\/reading$/],
        ['Map', /\/map$/],
        ['Assistants', /\/activity$/],
        ['Settings', /\/settings$/],
        ['Home', /\/home$/],
      ];
      for (const [name, url] of lands) {
        await entry(page, name).click();
        await expect(page, name).toHaveURL(url, { timeout: 15_000 });
        await expect.poll(() => currentName(page), { message: name }).toEqual([name]);
      }
    });
  });
}

test.describe('on a wide screen', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } });

  test('Right Now is the rail’s entry, counting what is due until it is done', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    await call('create_reminder', {
      text: 'Wedge the reclaim',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await page.goto('/home');
    const rightNow = entry(page, 'Right Now');
    await expect(rightNow).toHaveAccessibleName('Right Now, 1 due', { timeout: 15_000 });
    await expect(rightNow.locator('.count')).toHaveText('1');

    await rightNow.click();
    await expect(page).toHaveURL(/\/right-now$/);
    await page.getByRole('button', { name: 'Done: Wedge the reclaim' }).click();
    await expect(rightNow).toHaveAccessibleName('Right Now');
    await expect(rightNow.locator('.count')).toHaveCount(0);
  });

  test('the note at a reading measure, the notes beside it, no Right Now above them', async ({
    page,
  }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    const id = await aNote(call, `Kiln notes\n${LONG}`);
    await call('create_reminder', {
      text: 'Order more cones',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await page.goto(`/n/${id}`);
    const editor = page.getByRole('textbox', { name: 'New note' });
    await expect(editor).toContainText('Kiln notes', { timeout: 15_000 });

    // The text's column: about 70 characters, and not cramped either.
    await expectReadingMeasure(editor);

    // The notes list beside it, and no Right Now panel over the list.
    const list = page.getByRole('complementary', { name: 'All notes' });
    await expect(list).toBeVisible();
    const listBox = (await list.boundingBox())!;
    const editorBox = (await editor.boundingBox())!;
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(editorBox.x + 1);
    await expect(page.getByRole('region', { name: 'Right Now' })).toHaveCount(0);
    await expect(page.getByRole('separator', { name: 'Resize Right Now' })).toHaveCount(0);
    await expect(entry(page, 'Right Now')).toHaveAccessibleName('Right Now, 1 due');

    // A click in the blank beside the first line puts the cursor at its
    // end, as a click beside the text always did; typing lands there.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(editor).not.toBeFocused();
    const firstLine = editor.locator('.cm-line').first();
    const lineBox = (await firstLine.boundingBox())!;
    await page.mouse.click(
      Math.min(editorBox.x + editorBox.width - 8, lineBox.x + lineBox.width + 40),
      lineBox.y + lineBox.height / 2,
    );
    await expect(editor).toBeFocused();
    await page.keyboard.type(' today');
    await expect(firstLine).toHaveText('Kiln notes today');
    await letItSave(page);

    // And beside the text on the left, the same.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.click(editorBox.x + 4, lineBox.y + lineBox.height / 2);
    await expect(editor).toBeFocused();
    await noSeriousViolations(page);
  });

  test('Tab reaches Skip to content first, then the rail; axe on Home', async ({ page }) => {
    await signInAs(page, OWNER);
    await page.goto('/home');
    await expect(rail(page)).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    // The rail's menu button (2026-11-22), then its entries.
    await page.keyboard.press('Tab');
    await expect(menuButton(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(entry(page, 'Home')).toBeFocused();
    await expect(entry(page, 'Home')).toHaveAttribute('aria-current', 'page');
    // Home's own tiles are still there beside it, under their own name.
    await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
    await noSeriousViolations(page);

    await page.keyboard.press('Shift+Tab');
    await expect(menuButton(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    await expect(page).toHaveURL(/\/home$/);

    // The capture screen has no main: Skip to content puts the cursor in
    // the note, so what is typed next is the note's.
    await openCapture(page);
    const note = page.getByRole('textbox', { name: 'New note' });
    await expect(note).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await skip.focus();
    await page.keyboard.press('Enter');
    await expect(note).toBeFocused();
    await page.keyboard.type('Skipped straight in');
    await expect(note).toContainText('Skipped straight in');
  });

  test('not on the sign-in screens, nor signed out', async ({ page }) => {
    await page.goto('/dev-sign-in');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(rail(page)).toHaveCount(0);
    await page.goto('/home');
    await expect(page.getByRole('button', { name: /Sign in/ }).first()).toBeVisible();
    await expect(rail(page)).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--rail-width').trim(),
      ),
    ).toBe('0px');
  });
});

/** `--rail-width` as the page has it. */
const railWidth = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--rail-width').trim(),
  );
/** The leaf, Home in the bar, which gives way to the rail's Home. */
const leaf = (page: Page) => page.locator('app-home-link a');
/** The right edge of the rail. */
async function railEdge(page: Page): Promise<number> {
  const box = (await rail(page).boundingBox())!;
  return box.x + box.width;
}

test.describe('just under 900 px', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 899, height: 700 } });

  test('the rail is icons, and the note screen is the phone’s', async ({ page }) => {
    await signInAs(page, OWNER);
    await openCapture(page);
    await expect(page.getByRole('region', { name: 'Right Now' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'All notes' })).toBeHidden();
    await expect(rail(page)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Skip to content' })).toHaveCount(1);
    expect(await railWidth(page)).toBe('64px');
    // The rail's Home is the way home, as beside the full rail.
    await expect(leaf(page)).toBeHidden();
    await expect(entry(page, 'Home')).toBeVisible();
    expect(await contentLeft(page)).toBeGreaterThanOrEqual((await railEdge(page)) - 0.5);
    expect(await noSidewaysScroll(page)).toBe(true);

    // Widened to 900 px, the full rail and two panes; narrowed, icons again.
    await page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(() => railWidth(page)).toBe('176px');
    await expect(page.getByRole('region', { name: 'Right Now' })).toHaveCount(0);
    await page.setViewportSize({ width: 899, height: 700 });
    await expect.poll(() => railWidth(page)).toBe('64px');
    await expect(rail(page)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Right Now' })).toBeVisible();
  });
});

test.describe('at 640 px', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 640, height: 800 } });

  test('there is no rail, and the note screen is the phone’s', async ({ page }) => {
    await signInAs(page, OWNER);
    await openCapture(page);
    await expect(page.getByRole('region', { name: 'Right Now' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'All notes' })).toBeHidden();
    await expect(rail(page)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Skip to content' })).toHaveCount(0);
    expect(await railWidth(page)).toBe('0px');
    // The leaf is in the bar, as on a phone.
    await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    expect(await contentLeft(page)).toBe(0);

    // Widened to 641 px, the icons come; narrowed again, they go.
    await page.setViewportSize({ width: 641, height: 800 });
    await expect(rail(page)).toBeVisible();
    expect(await railWidth(page)).toBe('64px');
    await expect(leaf(page)).toBeHidden();
    await page.setViewportSize({ width: 640, height: 800 });
    await expect(rail(page)).toHaveCount(0);
    await expect(leaf(page)).toBeVisible();
    expect(await contentLeft(page)).toBe(0);
  });
});

// The tablet's rail (2026-11-16): icons alone from 641 to 899 px, beside
// the phone's one column, which is as it was but for the shift.
test.describe('on a tablet, 768 by 1024', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 768, height: 1024 } });

  test('a due count on Right Now’s icon, named as before', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    await call('create_reminder', {
      text: 'Wedge the reclaim',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await page.goto('/home');
    const rightNow = entry(page, 'Right Now');
    await expect(rightNow).toHaveAccessibleName('Right Now, 1 due', { timeout: 15_000 });
    await expect(rightNow).toHaveAttribute('title', 'Right Now, 1 due');
    const badge = rightNow.locator('.count');
    await expect(badge).toHaveText('1');
    await expect(badge).toBeVisible();
    // On the icon, inside the strip.
    const badgeBox = (await badge.boundingBox())!;
    const linkBox = (await rightNow.boundingBox())!;
    expect(badgeBox.x).toBeGreaterThanOrEqual(linkBox.x);
    expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(linkBox.x + linkBox.width + 0.5);
    await expect(entry(page, 'Map')).toHaveAttribute('title', 'Map');
    // The badge's figure is text, held to its contrast.
    await noSeriousViolations(page);

    await rightNow.click();
    await expect(page).toHaveURL(/\/right-now$/);
    await expect(rightNow).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: 'Done: Wedge the reclaim' }).click();
    await expect(rightNow).toHaveAccessibleName('Right Now');
    await expect(badge).toHaveCount(0);
  });

  test('Home beside the icons: its tiles, one h1, Skip first; axe', async ({ page }) => {
    await signInAs(page, OWNER);
    await page.goto('/home');
    await expect(rail(page)).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'New note' })).toBeVisible();
    expect(await contentLeft(page)).toBeGreaterThanOrEqual((await railEdge(page)) - 0.5);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menuButton(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(entry(page, 'Home')).toBeFocused();
    await expect(entry(page, 'Home')).toHaveAttribute('aria-current', 'page');
    await noSeriousViolations(page);
  });

  test('a saved note: Right Now’s line, More and the sheet beside the rail', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    const id = await aNote(call, `Kiln notes\n${LONG}`);
    await call('create_reminder', {
      text: 'Order more cones',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await page.goto(`/n/${id}`);
    const editor = page.getByRole('textbox', { name: 'New note' });
    await expect(editor).toContainText('Kiln notes', { timeout: 15_000 });
    await expect(entry(page, 'Notes')).toHaveAttribute('aria-current', 'page');
    const edge = await railEdge(page);

    // The phone's note screen: no list beside it, Right Now one line.
    await expect(page.getByRole('complementary', { name: 'All notes' })).toBeHidden();
    const region = page.getByRole('region', { name: 'Right Now' });
    const line = region.getByRole('button', { name: '1 due · Order more cones' });
    await expect(line).toBeVisible({ timeout: 15_000 });
    for (const part of [editor, line, page.locator('header.bar')]) {
      expect((await part.boundingBox())!.x).toBeGreaterThanOrEqual(edge - 0.5);
    }
    expect(await contentLeft(page)).toBeGreaterThanOrEqual(edge - 0.5);
    expect(await noSidewaysScroll(page)).toBe(true);
    await noSeriousViolations(page);

    // More opens in the page, clear of the rail.
    const menu = await openMore(page);
    expect((await menu.boundingBox())!.x).toBeGreaterThanOrEqual(edge - 0.5);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Right Now's sheet, likewise.
    await openRightNow(page);
    const sheet = page.locator('#right-now-sheet');
    await expect(sheet).toBeVisible();
    expect((await sheet.boundingBox())!.x).toBeGreaterThanOrEqual(edge - 0.5);
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(line).toHaveAttribute('aria-expanded', 'false');

    // Typing still lands in the note.
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' Wash the shelves.');
    await expect(editor).toContainText('Wash the shelves.');
  });

  test('no sideways scroll at 641, 768 and 899 px', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    const id = await aNote(call, `Kiln notes\n${LONG}`);
    for (const width of [641, 768, 899]) {
      await page.setViewportSize({ width, height: 1024 });
      for (const url of ['/home', `/n/${id}`, '/right-now', '/settings']) {
        await page.goto(url);
        await expect(rail(page), `${width} ${url}`).toBeVisible({ timeout: 15_000 });
        const box = (await rail(page).boundingBox())!;
        expect([width, url, box.x, box.width]).toEqual([width, url, 0, 64]);
        expect(await contentLeft(page), `${width} ${url}`).toBeGreaterThanOrEqual(box.width - 0.5);
        expect(await noSidewaysScroll(page), `${width} ${url}`).toBe(true);
      }
    }
  });
});

test.describe('on a touch tablet', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 768, height: 1024 } });

  test('the same icons, 44 px targets', async ({ page }) => {
    await signInAs(page, OWNER);
    await page.goto('/home');
    await expect(rail(page)).toBeVisible();
    expect((await rail(page).boundingBox())!.width).toBeLessThanOrEqual(64);
    for (const link of await rail(page).getByRole('link').all()) {
      const box = (await link.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await entry(page, 'Notes').tap();
    await expect(page).toHaveURL(/\/browse/);
    await expect(entry(page, 'Notes')).toHaveAttribute('aria-current', 'page');
    expect(await noSidewaysScroll(page)).toBe(true);
  });
});

// The rail's menu button (Eric, 2026-11-22): it switches the rail
// between names (176 px) and icons alone (64 px) at any width it is
// drawn at, the page taking the width; until it is pressed the width
// decides, and then the choice is kept on the device.

/** The rail's state as the button and the page say it. */
async function expectRail(page: Page, state: 'words' | 'icons'): Promise<void> {
  const words = state === 'words';
  await expect(menuButton(page)).toHaveAccessibleName(
    words ? 'Collapse navigation' : 'Expand navigation',
  );
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', `${words}`);
  await expect.poll(() => railWidth(page)).toBe(words ? '176px' : '64px');
  const box = (await rail(page).boundingBox())!;
  expect([box.x, box.width]).toEqual([0, words ? 176 : 64]);
  // The names show beside the icons, or are a title for a mouse.
  const map = entry(page, 'Map');
  await expect(map).toHaveAccessibleName('Map');
  if (words) {
    expect((await map.locator('.name').boundingBox())!.width).toBeGreaterThan(20);
    await expect(map).not.toHaveAttribute('title');
  } else {
    await expect(map).toHaveAttribute('title', 'Map');
    expect((await map.boundingBox())!.width).toBeLessThanOrEqual(64);
  }
  // A 44 px target either way, at the top of the rail.
  const button = (await menuButton(page).boundingBox())!;
  expect(button.width).toBeGreaterThanOrEqual(44);
  expect(button.height).toBeGreaterThanOrEqual(44);
  expect(button.y).toBeLessThan((await entry(page, 'Home').boundingBox())!.y);
  // The page beside the rail, never under it, and no sideways scroll.
  expect(await contentLeft(page)).toBeGreaterThanOrEqual(box.width - 0.5);
  expect(await noSidewaysScroll(page)).toBe(true);
}

test.describe('the rail’s menu button at 1440 by 900', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } });

  test('contracts the rail to icons, kept across a reload, and expands it again', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    const id = await aNote(call, `Kiln notes\n${LONG}`);
    await modulesOn(page);
    await page.goto(`/n/${id}`);
    const editor = page.getByRole('textbox', { name: 'New note' });
    await expect(editor).toContainText('Kiln notes', { timeout: 15_000 });
    await expect(column(page)).toBeVisible();

    // With nothing chosen, names at this width.
    await expectRail(page, 'words');
    const controls = await menuButton(page).getAttribute('aria-controls');
    expect(await rail(page).getAttribute('id')).toBe(controls);
    await expect(entry(page, 'Notes')).toHaveAttribute('aria-current', 'page');
    const before = (await editor.boundingBox())!;
    await noSeriousViolations(page);

    // Contracted: icons, the page takes the 112 px, the column stays.
    await menuButton(page).click();
    await expectRail(page, 'icons');
    await expect(menuButton(page)).toBeFocused();
    await expect(entry(page, 'Notes')).toHaveAttribute('aria-current', 'page');
    const after = (await editor.boundingBox())!;
    expect(after.x).toBeLessThan(before.x);
    expect(after.width).toBeGreaterThan(before.width);
    await expect(column(page)).toBeVisible();
    await expectReadingMeasure(editor);
    await noSeriousViolations(page);

    // Kept on the device: a reload keeps it contracted, on every screen.
    await page.reload();
    await expect(editor).toContainText('Kiln notes', { timeout: 15_000 });
    await expectRail(page, 'icons');
    for (const [url, lands, current] of screens(id)) {
      await page.goto(url);
      await expect(page).toHaveURL(lands, { timeout: 15_000 });
      await expect.poll(() => currentName(page), { message: url }).toEqual([current]);
      const box = (await rail(page).boundingBox())!;
      expect([url, box.x, box.width]).toEqual([url, 0, 64]);
      expect(await contentLeft(page), url).toBeGreaterThanOrEqual(63.5);
      expect(await noSidewaysScroll(page), url).toBe(true);
    }

    // Expanded again, from the keyboard.
    await page.goto('/home');
    await expect(rail(page)).toBeVisible();
    await menuButton(page).focus();
    await page.keyboard.press('Enter');
    await expectRail(page, 'words');
    await expect(entry(page, 'Home')).toHaveAttribute('aria-current', 'page');
    await page.reload();
    await expect(rail(page)).toBeVisible();
    await expectRail(page, 'words');
  });
});

test.describe('the rail’s menu button on a tablet, 768 by 1024', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 768, height: 1024 } });

  test('expands the icons to names, and the page still fits, down to 641 px', async ({ page }) => {
    test.setTimeout(150_000);
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    const id = await aNote(call, `Kiln notes\n${LONG}`);
    await modulesOn(page);
    await page.goto('/home');
    await expect(rail(page)).toBeVisible();

    // With nothing chosen, icons at this width.
    await expectRail(page, 'icons');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menuButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expectRail(page, 'words');
    await expect(entry(page, 'Home')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
    await noSeriousViolations(page);

    // The narrowest rail width, names shown: every screen still fits.
    await page.setViewportSize({ width: 641, height: 1024 });
    for (const [url, lands, current] of screens(id)) {
      await page.goto(url);
      await expect(page).toHaveURL(lands, { timeout: 15_000 });
      await expect.poll(() => currentName(page), { message: url }).toEqual([current]);
      const box = (await rail(page).boundingBox())!;
      expect([url, box.x, box.width]).toEqual([url, 0, 176]);
      expect(await contentLeft(page), url).toBeGreaterThanOrEqual(175.5);
      expect(await noSidewaysScroll(page), url).toBe(true);
    }

    // Contracted again: the tablet's icons.
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/home');
    await expect(rail(page)).toBeVisible();
    await menuButton(page).click();
    await expectRail(page, 'icons');
    await noSeriousViolations(page);
  });
});

// The context column (#289, part 2, 2026-11-16): from 1400 px a saved
// note's back is kept open beside its text, and Back is not offered.
const column = (page: Page) => page.getByRole('complementary', { name: 'Back of the note' });
const flippedBack = (page: Page) => page.getByRole('region', { name: 'Back of the note' });
const backButton = (page: Page) =>
  page.locator('header.bar').getByRole('button', { name: 'Back', exact: true });

/** A note with tags, and another linking to it; the first's id and the other's. */
async function linkedNotes(call: CallTool): Promise<{ kiln: string; firing: string }> {
  const kiln = (
    (await call('create_note', {
      body: `Kiln log\n${LONG}`,
      tags: ['studio'],
    })) as { id: string }
  ).id;
  const firing = await aNote(call, 'Firing day\nCheck the [[Kiln log]] before loading.');
  return { kiln, firing };
}

test.describe('the context column at 1440 by 900', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } });

  test('a saved note’s back, kept open beside it', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    const { kiln, firing } = await linkedNotes(call);
    await page.goto(`/n/${kiln}`);
    const editor = page.getByRole('textbox', { name: 'New note' });
    await expect(editor).toContainText('Kiln log', { timeout: 15_000 });

    // The back's parts, in a column's order, under the note's title.
    const side = column(page);
    await expect(side).toBeVisible();
    await expect(side.getByRole('heading', { level: 2 })).toHaveText('Kiln log');
    await expect(side.getByRole('heading', { level: 3 })).toHaveText(
      ['Linked from', 'Tags', 'Share a copy', 'What assistants changed', 'Send to an assistant'],
      { timeout: 15_000 },
    );
    const linkedFrom = side.getByRole('region', { name: 'Linked from' });
    await expect(linkedFrom.getByRole('link', { name: 'Firing day', exact: true })).toBeVisible();
    await expect(side).toContainText('studio');
    await expect(side.getByRole('link', { name: 'History', exact: true })).toBeVisible();
    // No Back to turn to, and no second copy of the back.
    await expect(backButton(page)).toHaveCount(0);
    await expect(flippedBack(page)).toHaveCount(0);

    // Beside the text, at the window's right, 280 px, scrolling itself;
    // the text keeps its measure and the page does not scroll sideways.
    const box = (await side.boundingBox())!;
    const editorBox = (await editor.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(editorBox.x + editorBox.width - 1);
    expect(Math.abs(box.x + box.width - 1440)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - 280)).toBeLessThanOrEqual(1);
    expect(box.y + box.height).toBeLessThanOrEqual(900 + 0.5);
    await expect(side).toHaveCSS('overflow-y', 'auto');
    await expectReadingMeasure(editor);
    expect(await noSidewaysScroll(page)).toBe(true);
    await noSeriousViolations(page);

    // Typing lands, and stays in the note while the column takes in
    // the edit it saved.
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' Wash the shelves.');
    await expect(editor).toContainText('Wash the shelves.');
    await letItSave(page);
    await expect(side.locator('.times')).toContainText('on this device');
    await expect(editor).toBeFocused();
    await page.keyboard.type(' Twice.');
    await expect(editor).toContainText('Wash the shelves. Twice.');
    await letItSave(page);

    // Its links work: Linked from opens the note that links here.
    await linkedFrom.getByRole('link', { name: 'Firing day', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/n/${firing}$`));
    await expect(editor).toContainText('Check the');
    await expect(side.getByRole('heading', { level: 2 })).toHaveText('Firing day');
    await expect(side.getByRole('region', { name: 'Linked from' })).toHaveCount(0);
    await expect(side).toContainText('Nothing links here yet.');
  });

  test('not on the capture screen, which keeps its Back', async ({ page }) => {
    await signInAs(page, OWNER);
    await openCapture(page);
    await page.keyboard.type('Glaze order');
    await letItSave(page);
    await expect(backButton(page)).toBeVisible();
    await expect(column(page)).toHaveCount(0);
    await backButton(page).click();
    await expect(flippedBack(page)).toBeVisible();
  });
});

test.describe('the context column’s breakpoint', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1400, height: 900 } });

  test('from 1400 px; under it, Back turns the note as before', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    const { kiln } = await linkedNotes(call);
    await page.goto(`/n/${kiln}`);
    const editor = page.getByRole('textbox', { name: 'New note' });
    await expect(editor).toContainText('Kiln log', { timeout: 15_000 });
    await expect(column(page)).toBeVisible();
    await expect(backButton(page)).toHaveCount(0);
    await expectReadingMeasure(editor);
    expect(await noSidewaysScroll(page)).toBe(true);

    for (const width of [1399, 1200]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(column(page), `${width}`).toHaveCount(0);
      expect(await noSidewaysScroll(page), `${width}`).toBe(true);
    }
    // The back as it always was: turned to, in place of the text.
    await backButton(page).click();
    const back = flippedBack(page);
    await expect(back).toBeVisible();
    await expect(
      back.getByRole('region', { name: 'Linked from' }).getByRole('link', { name: 'Firing day' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(editor).toBeHidden();
    await page.locator('header.bar').getByRole('button', { name: 'Front', exact: true }).click();
    await expect(back).toHaveCount(0);
    await expect(editor).toBeVisible();

    // Widened again, the column, and the note on its front.
    await backButton(page).click();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(column(page)).toBeVisible();
    await expect(flippedBack(page)).toHaveCount(0);
    await expect(editor).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  });
});

test.describe('the context column on a phone', () => {
  test('is not there: Back turns the note', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    const { kiln } = await linkedNotes(call);
    await page.goto(`/n/${kiln}`);
    await expect(page.getByRole('textbox', { name: 'New note' })).toContainText('Kiln log', {
      timeout: 15_000,
    });
    await expect(column(page)).toHaveCount(0);
    await backButton(page).click();
    await expect(
      flippedBack(page)
        .getByRole('region', { name: 'Linked from' })
        .getByRole('link', { name: 'Firing day' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(column(page)).toHaveCount(0);
  });
});
