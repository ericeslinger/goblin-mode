import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { connectClaude } from '../src/claude';
import {
  expect,
  letItSave,
  openCapture,
  openFromMore,
  openMore,
  openRightNow,
  signInAs,
  test,
  typeLines,
  openSettings,
  SETTINGS_PAGE_NAMES,
  switchModulesOn,
} from '../src/fixtures';
import { OWNER } from '../src/personas';

// The layout pass, step 1 (#285): nothing widens the phone's page,
// snippets read as plain words, and what is taller than its room
// scrolls in its own box instead of painting over Right Now. Step 2b
// (#286): one page header, whose parts stay on a 320 px screen. Step 3
// (#287): the phone's note screen gives the note the room; Right Now
// is one line under a saved note, a project's items fold to one line,
// Previous note and Projects are in More, and the bar's View, Back and
// More are icons.

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

  test('an open Projects list, from More, scrolls in its own box between the bar and Right Now', async ({
    page,
  }) => {
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
    // In More since 2026-11-15 (#287), no longer a pill under the note.
    await expect(page.getByRole('button', { name: 'Projects', exact: true })).toHaveCount(0);
    const list = await openFromMore(page, 'Projects');
    await expect(list.getByRole('listitem')).toHaveCount(19, { timeout: 15_000 });

    // Between the bar and Right Now, over neither.
    const rightNow = page.getByRole('region', { name: 'Right Now' });
    const listBox = (await list.boundingBox())!;
    const panelBox = (await rightNow.boundingBox())!;
    const barBox = (await page.locator('header.bar').boundingBox())!;
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(panelBox.y + 1);
    expect(listBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
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
    await expect(list).toHaveCount(0);
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
    // An earlier note and a project, so More offers Previous note and
    // Projects (#287; until then pills under the note).
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
    // View, Back and More are icons since #287: 44 by 44 boxes of
    // their own, not small text grown by an invisible area.
    for (const icon of [
      bar.getByRole('button', { name: 'View', exact: true }),
      back,
      bar.getByRole('button', { name: 'More' }),
    ]) {
      const box = (await icon.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await expect(rightNow.getByRole('link', { name: '1 more' })).toBeVisible({ timeout: 15_000 });
    expect(await missedTaps(rightNow.getByRole('link', { name: '1 more' }))).toEqual([]);

    // Previous note and Projects, the pills until #287, are items in
    // More: each item, and what its list offers, takes a 44 px tap.
    for (const [name, item] of [
      ['Previous note', /Glaze test/],
      ['Projects', /Kiln build/],
    ] as const) {
      const menu = await openMore(page);
      const choice = menu.getByRole('button', { name, exact: true });
      await expect(choice).toBeVisible({ timeout: 15_000 });
      expect(await missedTaps(choice)).toEqual([]);
      await choice.click();
      const list = page.getByRole('list', {
        name: name === 'Projects' ? 'Projects' : 'Previous notes',
        exact: true,
      });
      const first = list.getByRole('button', { name: item });
      await expect(first).toBeVisible({ timeout: 15_000 });
      expect(await missedTaps(first)).toEqual([]);
      const close = page.getByRole('button', {
        name: `Close ${name === 'Projects' ? 'Projects' : 'Previous notes'}`,
      });
      expect(await missedTaps(close)).toEqual([]);
      await close.click();
      await expect(list).toHaveCount(0);
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

    await openSettings(page, 'Account');
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
    await openSettings(page, 'Modules');
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

    await openSettings(page, 'Account');
    const signOut = page.getByRole('button', { name: 'Sign out' });
    await expect(signOut).toBeVisible({ timeout: 15_000 });
    // The signal holds for the plain base: a themed border, not outset.
    expect(await signOut.evaluate((b) => getComputedStyle(b).borderTopStyle)).toBe('solid');
    expect(await browserDefaultButtons(page)).toEqual([]);
    // Settings is pages since #290: each page's buttons, as the one long
    // page's were.
    for (const name of SETTINGS_PAGE_NAMES) {
      await openSettings(page, name);
      expect(await browserDefaultButtons(page), name).toEqual([]);
    }

    // Reader's feed management, with a feed followed so its row shows.
    await openSettings(page, 'Modules');
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
  test('a saved project opens with the room its note needs, Right Now one line that opens and closes', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    await call('create_concept', {
      name: 'Pottery',
      type: 'project',
      stages: ['Bisquing', 'Glazing'],
    });
    for (const [name, stage] of [
      ['Lovers vase', 'Bisquing'],
      ['Wounded pot', 'Glazing'],
      ['Teapot', 'Glazing'],
      ['Cup', undefined],
    ] as const) {
      await call('create_concept', {
        name,
        type: 'project',
        parent: 'c-pottery',
        ...(stage ? { stage } : {}),
      });
    }
    for (const text of ['Order cone packs', 'Mix the celadon']) {
      await call('create_reminder', { text, noteId: 'c-pottery' });
    }
    await call('create_reminder', {
      text: 'Pick up glazed mugs',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await page.goto('/n/c-pottery');
    const concept = page.getByRole('region', { name: 'Concept' });
    const fold = concept.locator('button[aria-controls="project-items"]');
    await expect(fold).toHaveText('4 projects · 2 open tasks · Bisquing 1, Glazing 2', {
      timeout: 15_000,
    });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    const rightNow = page.getByRole('region', { name: 'Right Now' });
    const line = rightNow.getByRole('button', { name: '1 due · Pick up glazed mugs' });
    await expect(line).toBeVisible({ timeout: 15_000 });
    await expect(line).toHaveAttribute('aria-expanded', 'false');
    // No handle under a saved note: the line is the way in.
    await expect(page.getByRole('separator', { name: 'Resize Right Now' })).toHaveCount(0);

    // The note has most of the screen.
    const viewport = page.viewportSize()!;
    const editor = (await page.locator('app-note-editor').boundingBox())!;
    expect(editor.height).toBeGreaterThanOrEqual(viewport.height * 0.6);
    expect(await missedTaps(line)).toEqual([]);
    await noSeriousViolations(page);

    // The line opens the panel over the lower part of the note.
    await line.click();
    await expect(line).toHaveAttribute('aria-expanded', 'true');
    // The focus goes into the sheet, so Tab carries on to its rows.
    await expect(rightNow.getByRole('link', { name: 'Right Now' })).toBeFocused();
    const done = rightNow.getByRole('button', { name: 'Done: Pick up glazed mugs' });
    const snooze = rightNow.getByRole('button', { name: 'Snooze: Pick up glazed mugs' });
    await expect(done).toBeVisible();
    await expect(snooze).toBeVisible();
    const sheet = (await page.locator('#right-now-sheet').boundingBox())!;
    const lineBox = (await line.boundingBox())!;
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(lineBox.y + 1);
    expect(sheet.y).toBeGreaterThan(editor.y);
    await noSeriousViolations(page);

    // The line again closes it; so does Escape, back on the line.
    await line.click();
    await expect(line).toHaveAttribute('aria-expanded', 'false');
    await expect(done).toHaveCount(0);
    await expect(line).toBeVisible();
    await openRightNow(page);
    await expect(done).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(done).toHaveCount(0);
    await expect(line).toBeFocused();
  });

  test('a project’s items fold to one line, open or closed as left after a reload', async ({
    page,
  }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    await call('create_concept', { name: 'Pottery', type: 'project' });
    await call('create_reminder', { text: 'Order cone packs', noteId: 'c-pottery' });

    await page.goto('/n/c-pottery');
    const concept = page.getByRole('region', { name: 'Concept' });
    const fold = concept.locator('button[aria-controls="project-items"]');
    const addTask = concept.getByRole('textbox', { name: 'Add a task' });
    await expect(fold).toHaveText('1 open task', { timeout: 15_000 });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(addTask).toHaveCount(0);
    expect(await missedTaps(fold)).toEqual([]);

    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(concept.getByRole('list', { name: 'Tasks' })).toContainText('Order cone packs');
    await expect(addTask).toBeVisible();
    await page.reload();
    await expect(fold).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
    await expect(addTask).toBeVisible();

    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await expect(fold).toHaveText('1 open task', { timeout: 15_000 });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(addTask).toHaveCount(0);
  });

  test('More holds Previous note and Projects, each opening its list', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    await call('create_concept', { name: 'Pottery', type: 'project' });
    await call('create_note', { body: 'Glaze notes\nCeladon over the bisque.' });

    await openCapture(page);
    // No row of pills under the note any more.
    await expect(page.getByRole('button', { name: 'Previous note' })).toHaveCount(0);
    const projects = await openFromMore(page, 'Projects');
    await projects.getByRole('button', { name: /Pottery/ }).click();
    await expect(page).toHaveURL(/\/n\/c-pottery$/);
    await expect(projects).toHaveCount(0);

    const previous = await openFromMore(page, 'Previous note');
    await previous.getByRole('button', { name: /Glaze notes/ }).click();
    await expect(page).toHaveURL(/\/n\/[^/]+$/);
    await expect(page.getByRole('textbox', { name: 'New note' })).toContainText(
      'Celadon over the bisque.',
    );
    await expect(previous).toHaveCount(0);
  });

  test('the bar’s View, Back and More are named icons a thumb can hit', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    await call('create_note', { body: 'Kiln log\nCone 6, slow cool.' });
    await openCapture(page);
    const previous = await openFromMore(page, 'Previous note');
    await previous.getByRole('button', { name: /Kiln log/ }).click();
    await expect(page).toHaveURL(/\/n\/[^/]+$/);

    const bar = page.locator('header.bar');
    for (const name of ['View', 'Back', 'More']) {
      const button = bar.getByRole('button', { name, exact: name !== 'More' });
      await expect(button).toBeVisible({ timeout: 15_000 });
      await expect(button).toHaveAttribute('title', name);
      await expect(button.locator('svg')).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await missedTaps(button)).toEqual([]);
    }
    // Each still names what a tap turns to.
    await bar.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(bar.getByRole('button', { name: 'Front', exact: true })).toHaveAttribute(
      'title',
      'Front',
    );
    await bar.getByRole('button', { name: 'Front', exact: true }).click();
    await bar.getByRole('button', { name: 'View', exact: true }).click();
    await expect(bar.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute(
      'title',
      'Edit',
    );
    await noSeriousViolations(page);
  });

  test('the empty capture screen keeps Right Now’s handle', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    await call('create_reminder', {
      text: 'Call the bank',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await openCapture(page);
    const handle = page.getByRole('separator', { name: 'Resize Right Now' });
    await expect(handle).toHaveAttribute('aria-valuenow', '35', { timeout: 15_000 });
    const rightNow = page.getByRole('region', { name: 'Right Now' });
    await expect(rightNow.getByRole('button', { name: 'Done: Call the bank' })).toBeVisible();
    await expect(rightNow.locator('button[aria-controls="right-now-sheet"]')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'New note' })).toBeFocused();
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
  if (parent) {
    await expect(back).toHaveAccessibleName(`Back to ${parent}`);
    // However long the title, the link keeps a thumb's width and
    // stays clear of it.
    const [link, heading] = [(await back.boundingBox())!, (await h1.boundingBox())!];
    expect(link.width, `${title}: the back link`).toBeGreaterThanOrEqual(44);
    expect(link.x + link.width, `${title}: the back link`).toBeLessThanOrEqual(heading.x + 0.5);
  } else await expect(back).toHaveCount(0);

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
      (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).fontSize),
    );
    // One line is under two font sizes tall, whatever the line height.
    expect(lines, `${title}: the title is broken mid-word`).toBeLessThan(2);
  }
  for (const action of await header.locator('.actions > *').all()) {
    if (await action.isVisible()) await inside(await action.boundingBox(), `${title}: an action`);
  }
}

/**
 * Each control is inside the screen, its centre lands on itself, and so
 * does every point of its 44 px area, whichever row of a wrapped bar it
 * is on (the areas meet mid-gap, 2026-11-15).
 */
async function expectOwnTaps(page: Page, controls: Locator[]): Promise<void> {
  const width = page.viewportSize()!.width;
  for (const control of controls) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    const centre = await control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    });
    expect(centre).toBe(true);
    expect(await missedTaps(control)).toEqual([]);
  }
}

test.describe('on a narrow phone', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('the note bar, wrapped to two rows, keeps each tap on its own control', async ({ page }) => {
    test.setTimeout(90_000);
    await signInAs(page, OWNER);
    // A template, so From template joins the bar. With View, Back and
    // More as 44 px icons (#287) it still needs about 370 px: the leaf
    // and New note 80, From template about 95, three icons 132, five
    // 12 px gaps; at 320 px the bar has 288, so Back and More wrap.
    await openSettings(page, 'Templates');
    await page.getByRole('button', { name: 'New template', exact: true }).click();
    await expect(page).toHaveURL(/\/n\/\w+$/);
    const editor = page.getByRole('textbox', { name: 'New note' });
    // The template's text can arrive after the page does (#226): clear
    // it only once the template header shows, or it comes back under
    // the typing (failed once so, #312).
    await expect(page.getByRole('region', { name: 'Template' })).toBeVisible();
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
    await expectOwnTaps(page, controls);
  });

  test('the note bar at 320 px, wrapped or not, keeps each tap on its own control', async ({
    page,
  }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    // A plain saved note: the leaf, New note, View, Back and More, which
    // by the same sums fit one row (about 260 of 288 px). Whether it
    // wraps is not asserted, only that each control is on the screen
    // and its tap is its own.
    const kiln = (await call('create_note', { body: 'Kiln log\nCone 6, slow cool.' })) as {
      id: string;
    };
    await page.goto(`/n/${kiln.id}`);
    const bar = page.locator('header.bar');
    const controls = [
      bar.getByRole('link', { name: 'Home', exact: true }),
      bar.getByRole('button', { name: 'New note', exact: true }),
      bar.getByRole('button', { name: 'View', exact: true }),
      bar.getByRole('button', { name: 'Back', exact: true }),
      bar.getByRole('button', { name: 'More' }),
    ];
    for (const control of controls) await expect(control).toBeVisible({ timeout: 15_000 });
    await expectOwnTaps(page, controls);
  });

  test('every screen has the one page header, inside the screen', async ({ page }) => {
    test.setTimeout(120_000);
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    const { id } = (await call('create_note', { body: 'Studio day\nclay' })) as { id: string };
    const long = 'Glaze test notes for the celadon';
    const longNote = (await call('create_note', { body: `${long}\nclay` })) as { id: string };

    // The modules with a header of their own, on as other journeys do.
    // Podcasts comes on with the Reader (#245): the helper waits for it
    // and never clicks it as it turns on.
    await switchModulesOn(page, 'Reader', 'Podcasts', 'Kitchen');
    await letItSave(page);

    const screens: [url: string, title: string, parent?: string][] = [
      ['/browse', 'Notes'],
      ['/right-now', 'Right Now'],
      ['/settings', 'Settings'],
      ['/settings/modules', 'Modules', 'Settings'],
      ['/settings/assistants', 'AI assistants', 'Settings'],
      ['/reading', 'Reading queue'],
      ['/map', 'Map'],
      [`/map/n/${id}`, 'Around Studio day', 'Note'],
      [`/map/n/${longNote.id}`, `Around ${long}`, 'Note'],
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

  // Until #289 (2026-11-16) Right Now sat above the notes here, capped
  // and scrolling inside (#285). It is now the rail's entry, its count
  // what is due, and the notes list has the whole left pane.
  test('the notes list has the left pane, Right Now being the rail’s entry', async ({ page }) => {
    await signInAs(page, OWNER);
    const call = await connectClaude(page);
    const long = 'ring about the kiln shelves, the cone packs and the glaze order '.repeat(3);
    for (const n of [1, 2, 3, 4]) {
      await call('create_reminder', {
        text: `Reminder ${n}: ${long.trim()}`,
        dueAt: new Date(Date.now() - n * 60_000).toISOString(),
      });
    }

    await openCapture(page);
    const entry = page
      .getByRole('navigation', { name: 'Places', exact: true })
      .getByRole('link', { name: 'Right Now, 4 due', exact: true });
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('region', { name: 'Right Now' })).toHaveCount(0);
    // The list starts under the bar, nothing between them.
    const bar = (await page.locator('header.bar').boundingBox())!;
    const list = (await page.getByRole('complementary', { name: 'All notes' }).boundingBox())!;
    expect(Math.abs(list.y - (bar.y + bar.height))).toBeLessThanOrEqual(1);
    await noSeriousViolations(page);

    await entry.click();
    await expect(page.getByRole('heading', { name: 'Right Now', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Done: Reminder/ })).toHaveCount(4);
  });
});
