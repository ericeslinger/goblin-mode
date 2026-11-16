import AxeBuilder from '@axe-core/playwright';
import { type Page, devices } from '@playwright/test';
import {
  expect,
  letItSave,
  prepPage,
  signInAs,
  test,
  typeLines,
  openSettings,
} from '../src/fixtures';
import { OWNER } from '../src/personas';

// Where he left off (#272, Eric, 2026-11-15): a plain launch of `/`
// goes back to the place open last on this device, its scroll and a
// note's caret too; a share still opens the share page; New note,
// beside the leaf, is the fresh note a launch used to give; and a
// place that has gone falls back to Home. A first launch (a fresh
// account here) lands on the capture note, as it always did.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });
const scroller = (page: Page) => page.locator('app-note-editor .cm-scroller');
const scrolledTo = (page: Page) => scroller(page).evaluate((el) => Math.round(el.scrollTop));

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test('a long note, scrolled and the caret in it, is where it was after / is opened again', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // A short screen, so forty lines scroll.
  await page.setViewportSize({ width: 412, height: 420 });
  await signInAs(page, OWNER);
  const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`);
  await typeLines(page, lines);
  await letItSave(page);
  // The caret at the end of line 20, the view scrolled elsewhere.
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < 19; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await scroller(page).evaluate((el) => (el.scrollTop = 300));
  expect(await scrolledTo(page)).toBe(300);
  await letItSave(page);

  // Opened again at `/`, as the installed app is from its icon.
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await expect(note(page)).toContainText('Line 1');
  await expect.poll(() => scrolledTo(page), { timeout: 20_000 }).toBe(300);
  // Typing carries on at the caret, where it was left.
  await page.keyboard.type('!');
  await expect(note(page).locator('.cm-line', { hasText: /^Line 20!$/ })).toHaveCount(1);
  await letItSave(page);
});

test('an article read part-way down is where it was after / is opened again, in its shelf', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  await openSettings(page, 'Modules');
  await page.getByRole('switch', { name: 'Reader' }).check();
  await letItSave(page);
  await page.goto('/reader/feeds');
  await page.getByRole('textbox', { name: 'Feed link' }).fill('https://feeds.invalid/design.xml');
  await page.getByRole('combobox', { name: 'Folder' }).fill('Design');
  await page.getByRole('button', { name: 'Follow' }).click();
  await expect(page.getByRole('textbox', { name: 'Feed link' })).toHaveValue('');
  await letItSave(page);
  await page.goto('/reader/folders');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('new articles', { timeout: 30_000 });
  await page.goto('/reader');
  const tabs = page.getByRole('navigation', { name: 'Reader screens' });
  await expect(tabs.getByRole('link', { name: /^All/ })).toContainText('3 unread');

  // A short screen, so even a fixture's article scrolls.
  await page.setViewportSize({ width: 412, height: 240 });
  await page
    .getByRole('group', { name: 'Articles', exact: true })
    .getByRole('link', { name: /Celadon/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Celadon glazes', level: 1 })).toBeVisible();
  const where = page.url();
  const place = await page.locator('.place').innerText();
  const room = await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight);
  expect(room).toBeGreaterThan(40);
  const y = Math.floor(room / 2);
  await page.evaluate((top) => window.scrollTo({ top }), y);
  await letItSave(page);

  await page.goto('/');
  await expect(page).toHaveURL(where);
  await expect(page.getByRole('heading', { name: 'Celadon glazes', level: 1 })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Math.round(window.scrollY)), { timeout: 20_000 })
    .toBe(y);
  // Its place on the shelf, so Previous and Next go where they went.
  await expect(page.locator('.place')).toHaveText(place);
});

test('a share still opens the share page, whatever was open last', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  // Words with a link: the share page asks what to do with it. (Words
  // alone become a note at once, and the page takes the query out of
  // its address once it has kept the share.)
  await page.goto(
    '/share?title=Seeds&text=what%20if%20we%20sowed%20early&url=https%3A%2F%2Fexample.test%2Fseeds&at=1',
  );
  await expect(page).toHaveURL(/\/share$/);
  await expect(page.getByRole('button', { name: 'Keep as a note' })).toBeVisible();
});

test('New note from the Reader gives a note ready to type, and is named and reachable', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  await openSettings(page, 'Modules');
  await page.getByRole('switch', { name: 'Reader' }).check();
  await letItSave(page);
  await page.goto('/reader');
  await expect(page.getByRole('heading', { name: 'Reader', level: 1 })).toBeVisible();
  const newNote = page.getByRole('button', { name: 'New note', exact: true });
  // Beside the leaf, the leaf's size.
  const leaf = (await page.getByRole('link', { name: 'Home' }).boundingBox())!;
  const box = (await newNote.boundingBox())!;
  expect(box.width).toBe(leaf.width);
  expect(box.height).toBe(leaf.height);
  expect(box.x).toBeGreaterThanOrEqual(leaf.x + leaf.width - 1);
  await expectNoSeriousViolations(page);

  await newNote.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(note(page)).toBeFocused();
  await page.keyboard.type('From the Reader');
  await expect(note(page)).toHaveText('From the Reader');
  await letItSave(page);
  // And opened again, that is where it was left.
  await page.goto('/');
  await expect(note(page)).toHaveText('From the Reader');
});

test('a note deleted on another device since: / falls back to Home', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await signInAs(page, OWNER);
  await typeLines(page, ['Glaze notes', 'Celadon over the bisque']);
  await letItSave(page);
  // New, then back: the note at its own URL, the last place here.
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/n\/\w+$/);
  await expect(note(page)).toContainText('Glaze notes');
  const id = /\/n\/([^/?#]+)/.exec(page.url())![1];
  await letItSave(page);

  // Another device deletes it.
  const other = await browser.newContext({ ...devices['Pixel 7'] });
  const second = await other.newPage();
  await prepPage(second);
  await signInAs(second, OWNER, { reset: false });
  await second.goto(`/n/${id}`);
  await expect(note(second)).toContainText('Glaze notes', { timeout: 15_000 });
  await second.getByRole('button', { name: 'Back', exact: true }).click();
  const back = second.getByRole('region', { name: 'Back of the note' });
  await back.getByRole('button', { name: 'Delete' }).click();
  await back.getByRole('button', { name: 'Yes' }).click();
  await expect(second).toHaveURL(/\/$/);
  await letItSave(second);
  await other.close();

  // The phone opens the app: not the note, nor a blank one in its place.
  await page.goto('/');
  await expect(page).toHaveURL(/\/home$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Mossgoblin', level: 1 })).toBeVisible();
});
