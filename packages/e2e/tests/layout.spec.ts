import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import { expect, letItSave, openCapture, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The layout pass, step 1 (#285): nothing widens the phone's page,
// snippets read as plain words, and what is taller than its room
// scrolls in its own box instead of painting over Right Now. Step 2b
// (#286): one page header, whose parts stay on a 320 px screen.

/** A 300-character address with nowhere to break. */
const ADDRESS = `https://example.com/${'a'.repeat(280)}`;

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/**
 * Where a tap 21 px from the control's centre, across, down and on the
 * diagonals, does not land on it: none for a 44 px target, whether its
 * box is that big or an invisible area around it is (step 2a, #286).
 */
async function missedTaps(control: Locator): Promise<string[]> {
  await control.scrollIntoViewIfNeeded();
  return control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    const missed: string[] = [];
    // 21 px each way across and down; 14 on the diagonals, which is
    // still inside a round control 44 px across.
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
 * The visible buttons still in the browser's own look: its outset
 * border and button face (read from a button in a shadow root, where
 * the app's styles do not reach), or a font of their own rather than
 * their parent's.
 */
async function browserDefaultButtons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const host = document.createElement('div');
    const probe = document.createElement('button');
    host.attachShadow({ mode: 'open' }).append(probe);
    document.body.append(host);
    const own = getComputedStyle(probe);
    const plain = { border: own.borderTopStyle, face: own.backgroundColor };
    host.remove();
    return [...document.querySelectorAll('button')]
      .filter((b) => b.checkVisibility())
      .filter((b) => {
        const s = getComputedStyle(b);
        const parent = getComputedStyle(b.parentElement!);
        return (
          (s.borderTopStyle === plain.border && s.backgroundColor === plain.face) ||
          s.borderTopStyle === 'outset' ||
          s.fontFamily !== parent.fontFamily
        );
      })
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '');
  });
}

/** How an element scrolls: its sizes and its computed overflow-y. */
const scrolling = (el: Element) => ({
  scrollHeight: el.scrollHeight,
  clientHeight: el.clientHeight,
  overflowY: getComputedStyle(el).overflowY,
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 412, height: 839 } });

  test('a long image address wraps in Browse instead of widening the page', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    // One under its title, one as its first line, so the title wraps too.
    await call('create_note', { body: `Clipped bowl\n![](${ADDRESS})\nCeladon over the bisque.` });
    await call('create_note', { body: `![](${ADDRESS})\nA picture first.` });

    await page.goto('/browse');
    const notes = page.getByRole('list', { name: 'Notes' });
    const clipped = notes.getByRole('link', { name: /Clipped bowl/ });
    await expect(clipped).toBeVisible({ timeout: 15_000 });
    await expect(notes.getByRole('link', { name: /A picture first/ })).toBeVisible({
      timeout: 15_000,
    });
    const snippet = clipped.locator('.snippet');
    await expect(snippet).toHaveText('Celadon over the bisque.');
    expect(await snippet.textContent()).not.toMatch(/\]\(|http/);

    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client);
  });

  test('a Browse row shows plain words, not the marks typed', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    await call('create_note', {
      body: 'Glaze plans\nAsk [[Some name]] about the *bold* celadon, _gently_',
    });

    await page.goto('/browse');
    const row = page
      .getByRole('list', { name: 'Notes' })
      .getByRole('link', { name: /Glaze plans/ });
    await expect(row.locator('.snippet')).toHaveText(
      'Ask Some name about the bold celadon, gently',
      { timeout: 15_000 },
    );
  });

  test('an open Projects list scrolls in its own box above Right Now', async ({ page }) => {
    test.setTimeout(90_000);
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    // Eric's garden has 19 projects: more than the room above Right Now.
    for (let i = 1; i <= 19; i++) {
      await call('create_concept', {
        name: `Project ${String(i).padStart(2, '0')}`,
        type: 'project',
      });
    }
    // Something due, so Right Now is open at its usual share.
    await call('create_reminder', {
      text: 'Call the bank',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await openCapture(page);
    const handle = page.getByRole('separator', { name: 'Resize Right Now' });
    await expect(handle).toHaveAttribute('aria-valuenow', '35', { timeout: 15_000 });
    const pill = page.getByRole('button', { name: 'Projects', exact: true });
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await pill.click();
    const list = page.getByRole('list', { name: 'Projects' });
    await expect(list.getByRole('listitem')).toHaveCount(19, { timeout: 15_000 });

    const rightNow = page.getByRole('region', { name: 'Right Now' });
    const listBox = (await list.boundingBox())!;
    const panelBox = (await rightNow.boundingBox())!;
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(panelBox.y + 1);
    const box = await list.evaluate(scrolling);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    expect(['auto', 'scroll']).toContain(box.overflowY);
    // The note keeps room of its own while the list is open.
    expect((await page.locator('app-note-editor').boundingBox())!.height).toBeGreaterThan(100);

    // The last project is reached by scrolling the list, and opens.
    const last = list.getByRole('button', { name: /Project 19/ });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await noSeriousViolations(page);
    await last.click();
    await expect(page).toHaveURL(/\/n\/c-project-19$/);
  });

  test('the controls a thumb reaches for take a 44 px tap', async ({ page }) => {
    test.setTimeout(150_000);
    await signInAs(page, OWNER);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const call = await connectClaude(page);
    await call('create_reminder', {
      text: 'Call the bank',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // Three more due after it, so Right Now shows three and "1 more".
    for (const n of [1, 2, 3]) {
      await call('create_reminder', {
        text: `Water bed ${n}`,
        dueAt: new Date(Date.now() - (40 - n * 10) * 1000).toISOString(),
      });
    }
    // An earlier note and a project, so the pills show under the note.
    await call('create_note', { body: 'Glaze test\nCeladon' });
    await call('create_concept', { name: 'Kiln build', type: 'project' });

    // A note with text, saved, so View and Back are in the bar.
    await openCapture(page);
    await typeLines(page, ['Kiln log']);
    await letItSave(page);
    const back = page.getByRole('button', { name: 'Back', exact: true });
    await expect(back).toBeVisible({ timeout: 15_000 });
    // Off the note, so nothing docked to the keyboard sits over Right Now.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const bar = page.locator('header.bar');
    const rightNow = page.getByRole('region', { name: 'Right Now' });
    await expect(rightNow.getByRole('button', { name: 'Done: Call the bank' })).toBeVisible({
      timeout: 15_000,
    });
    for (const control of [
      bar.getByRole('button', { name: 'New note' }),
      bar.getByRole('button', { name: 'View', exact: true }),
      back,
      bar.getByRole('button', { name: 'More' }),
      rightNow.getByRole('button', { name: 'Done: Call the bank' }),
      rightNow.getByRole('button', { name: 'Snooze: Call the bank' }),
    ]) {
      expect(await missedTaps(control)).toEqual([]);
    }
    // The small text buttons keep their look: the box itself is smaller.
    expect((await back.boundingBox())!.height).toBeLessThan(44);
    await expect(rightNow.getByRole('link', { name: '1 more' })).toBeVisible({ timeout: 15_000 });
    expect(await missedTaps(rightNow.getByRole('link', { name: '1 more' }))).toEqual([]);

    // The pills under the note. Step 3 moves them into More: then this
    // block goes.
    for (const name of ['Previous note', 'Projects']) {
      const pill = page.getByRole('button', { name, exact: true });
      await expect(pill).toBeVisible({ timeout: 15_000 });
      expect(await missedTaps(pill)).toEqual([]);
    }

    await page.goto('/browse');
    const lenses = page.getByRole('navigation', { name: 'Lenses' });
    await expect(lenses.getByRole('link').first()).toBeVisible({ timeout: 15_000 });
    for (const chip of [lenses.getByRole('link').first(), lenses.getByRole('link').last()]) {
      expect(await missedTaps(chip)).toEqual([]);
    }

    await page.goto('/right-now');
    const row = page.getByRole('main');
    await expect(row.getByRole('button', { name: 'Done: Call the bank' })).toBeVisible({
      timeout: 15_000,
    });
    expect(await missedTaps(row.getByRole('button', { name: 'Done: Call the bank' }))).toEqual([]);
    expect(await missedTaps(row.getByRole('button', { name: 'Snooze: Call the bank' }))).toEqual(
      [],
    );
    expect(await missedTaps(row.getByRole('button', { name: 'Add a reminder' }))).toEqual([]);

    await page.goto('/settings');
    const signOut = page.getByRole('button', { name: 'Sign out' });
    await expect(signOut).toBeVisible({ timeout: 15_000 });
    expect(await missedTaps(signOut)).toEqual([]);
    await noSeriousViolations(page);

    // A button reached by Tab shows a focus ring of 2 px or more.
    for (let i = 0; i < 6 && !(await signOut.evaluate((b) => b === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(signOut).toBeFocused();
    const ring = await signOut.evaluate((b) => {
      const s = getComputedStyle(b);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThanOrEqual(2);

    // A meal plan's tick box, tapped 15 px from its centre: ticked once.
    await page.getByRole('switch', { name: 'Kitchen' }).check();
    await letItSave(page);
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Kitchen' })).toBeChecked();
    await page.goto('/kitchen/2026-10-21');
    const plan = page.getByRole('region', { name: 'Meal plan' });
    await plan.getByRole('button', { name: 'Change Tue dinner, Oct 20: nothing planned' }).click();
    await plan.getByRole('button', { name: 'Delivery' }).click();
    const made = plan.getByRole('checkbox', { name: 'Made Tue dinner, Oct 20' });
    await expect(made).not.toBeChecked({ timeout: 15_000 });
    await made.scrollIntoViewIfNeeded();
    const box = (await made.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2 - 15, box.y + box.height / 2);
    await expect(made).toBeChecked();
    await letItSave(page);
    await expect(made).toBeChecked();
  });

  test('no button is left in the browser’s own look', async ({ page }) => {
    test.setTimeout(90_000);
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    await call('create_reminder', {
      text: 'Call the bank',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await page.goto('/settings');
    const signOut = page.getByRole('button', { name: 'Sign out' });
    await expect(signOut).toBeVisible({ timeout: 15_000 });
    // The signal holds for the plain base: a themed border, not outset.
    expect(await signOut.evaluate((b) => getComputedStyle(b).borderTopStyle)).toBe('solid');
    expect(await browserDefaultButtons(page)).toEqual([]);

    // Reader's feed management, with a feed followed so its row shows.
    await page.getByRole('switch', { name: 'Reader' }).check();
    await letItSave(page);
    await page.goto('/reader/feeds');
    await page.getByRole('textbox', { name: 'Feed link' }).fill('https://feeds.invalid/design.xml');
    await page.getByRole('combobox', { name: 'Folder' }).fill('Design');
    await page.getByRole('button', { name: 'Follow', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Feed link' })).toHaveValue('');
    await page.locator('summary', { hasText: 'Design' }).click();
    await expect(page.getByRole('button', { name: /^Remove: / })).toBeVisible({
      timeout: 15_000,
    });
    expect(await browserDefaultButtons(page)).toEqual([]);

    await openCapture(page);
    await typeLines(page, ['Kiln log']);
    await letItSave(page);
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Done: Call the bank' })).toBeVisible({
      timeout: 15_000,
    });
    expect(await browserDefaultButtons(page)).toEqual([]);
  });
});

/**
 * The page header (step 2b, #286) as a phone draws it: one h1, the
 * leaf in the header, "Back to <parent>" where there is a parent and
 * none where there is not, and the header, its actions and the page
 * all inside the screen's width.
 */
async function expectPageHeader(page: Page, title: string, parent?: string): Promise<void> {
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1).toHaveText(title, { timeout: 15_000 });
  await expect(h1).toHaveCount(1);
  const header = page.locator('app-page-header header');
  await expect(header).toHaveCount(1);
  await expect(header.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  const back = header.getByRole('link', { name: /^Back to / });
  if (parent) await expect(back).toHaveAccessibleName(`Back to ${parent}`);
  else await expect(back).toHaveCount(0);

  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll, `${title}: the page scrolls sideways`).toBeLessThanOrEqual(width.client);
  const inside = async (box: { x: number; width: number } | null, what: string) => {
    expect(box, what).not.toBeNull();
    expect(box!.x, what).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, what).toBeLessThanOrEqual(width.client + 0.5);
  };
  await inside(await header.boundingBox(), `${title}: the header`);
  // A one-word title is never broken across lines: the parent's name
  // in the back link gives way first.
  if (!/\s/.test(title)) {
    const lines = await h1.evaluate(
      (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
    );
    expect(lines, `${title}: the title is broken mid-word`).toBeLessThan(1.5);
  }
  for (const action of await header.locator('.actions > *').all()) {
    if (await action.isVisible()) await inside(await action.boundingBox(), `${title}: an action`);
  }
}

test.describe('on a narrow phone', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('the note bar, wrapped to two rows, keeps each tap on its own control', async ({ page }) => {
    test.setTimeout(90_000);
    await signInAs(page, OWNER);
    // A template, so From template joins the bar: with View, Back and
    // More it no longer fits one row at 320 px.
    await page.goto('/settings');
    await page.getByRole('button', { name: 'New template', exact: true }).click();
    await expect(page).toHaveURL(/\/n\/\w+$/);
    const editor = page.getByRole('textbox', { name: 'New note' });
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await typeLines(page, ['Packing list', 'socks']);
    await letItSave(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const bar = page.locator('header.bar');
    const controls = [
      bar.getByRole('link', { name: 'Home', exact: true }),
      bar.getByRole('button', { name: 'New note', exact: true }),
      bar.getByRole('button', { name: 'From template', exact: true }),
      bar.getByRole('button', { name: 'View', exact: true }),
      bar.getByRole('button', { name: 'Back', exact: true }),
      bar.getByRole('button', { name: 'More' }),
    ];
    for (const control of controls) await expect(control).toBeVisible({ timeout: 15_000 });
    const tops = new Set<number>();
    for (const control of controls) tops.add(Math.round((await control.boundingBox())!.y / 8));
    expect(tops.size, 'the bar wraps').toBeGreaterThan(1);

    for (const control of controls) {
      // Its centre is its own; so is every point of its 44 px area,
      // whichever row it is on (the areas meet mid-gap, 2026-11-15).
      const centre = await control.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !!hit && el.contains(hit);
      });
      expect(centre).toBe(true);
      expect(await missedTaps(control)).toEqual([]);
    }
  });

  test('every screen has the one page header, inside the screen', async ({ page }) => {
    test.setTimeout(120_000);
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    const { id } = (await call('create_note', { body: 'Studio day\nclay' })) as { id: string };

    // The modules with a header of their own, on as other journeys do.
    await page.goto('/settings');
    for (const name of ['Reader', 'Podcasts', 'Kitchen']) {
      await page.getByRole('switch', { name }).check();
    }
    await letItSave(page);

    const screens: [url: string, title: string, parent?: string][] = [
      ['/browse', 'Notes'],
      ['/right-now', 'Right Now'],
      ['/settings', 'Settings'],
      ['/reading', 'Reading queue'],
      ['/map', 'Map'],
      [`/map/n/${id}`, 'Around Studio day', 'Note'],
      [`/history?note=${id}`, 'History', 'Note'],
      ['/activity', 'What assistants changed'],
      ['/reader', 'Reader'],
      ['/reader/feeds', 'Manage feeds', 'Reader'],
      ['/reader/downloads', 'Downloads', 'Podcasts'],
      ['/podcasts', 'Podcasts'],
      ['/podcasts/add', 'Add a podcast', 'Podcasts'],
      ['/kitchen/shopping', 'Kitchen'],
      ['/kitchen/recipes', 'Kitchen'],
    ];
    for (const [url, title, parent] of screens) {
      await page.goto(url);
      await expectPageHeader(page, title, parent);
      if (url === '/right-now' || url === '/reader/feeds') await noSeriousViolations(page);
    }

    // The back link goes where it says.
    await page.goto('/reader/feeds');
    await page.getByRole('link', { name: 'Back to Reader', exact: true }).click();
    await expect(page).toHaveURL(/\/reader$/);
    await page.goto(`/map/n/${id}`);
    await page.getByRole('link', { name: 'Back to Note', exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/n/${id}`);
  });
});

test.describe('on a wide screen', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } });

  test('Right Now beside the notes scrolls inside its cap, its heading in sight', async ({
    page,
  }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    // Long reminders, so the three shown are taller than the cap.
    const long = 'ring about the kiln shelves, the cone packs and the glaze order '.repeat(3);
    for (const n of [1, 2, 3, 4]) {
      await call('create_reminder', {
        text: `Reminder ${n}: ${long.trim()}`,
        dueAt: new Date(Date.now() - n * 60_000).toISOString(),
      });
    }

    await openCapture(page);
    const rightNow = page.getByRole('region', { name: 'Right Now' });
    await expect(rightNow.getByRole('button', { name: /^Done: Reminder/ })).toHaveCount(3, {
      timeout: 15_000,
    });
    const box = await rightNow.evaluate(scrolling);
    // Capped (40% of the height, and its padding) well short of the
    // window, it scrolls rather than clips.
    expect(box.clientHeight).toBeLessThan(900 * 0.5);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    expect(['auto', 'scroll']).toContain(box.overflowY);

    // Scrolled to its end, the heading is still at its top.
    await rightNow.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const heading = rightNow.getByRole('heading', { name: 'Right Now' });
    await expect
      .poll(async () => {
        const [h, r] = [(await heading.boundingBox())!, (await rightNow.boundingBox())!];
        return Math.abs(h.y - r.y);
      })
      .toBeLessThanOrEqual(1);
    await expect(rightNow.getByRole('link', { name: '1 more' })).toBeInViewport();
    await noSeriousViolations(page);
  });
});
