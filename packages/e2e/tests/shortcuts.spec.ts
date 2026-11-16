import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  FIRESTORE_EMULATOR,
  expect,
  letItSave,
  openCapture,
  openSettings,
  signInAs,
  switchModulesOn,
  test,
} from '../src/fixtures';
import { OWNER } from '../src/personas';

// The desktop shell's keys (#289, step 5; Eric, 2026-11-15): `/` to
// Notes' search, `g` then a letter to a place, and the command box on
// Ctrl K, or Cmd K on Apple platforms only (#313; `ControlOrMeta` is
// the same split, Ctrl on the Linux test browser). Never while typing:
// what is typed in a note or a field reaches it as ever, and the editor
// keeps its own Mod-K (a link). A checkbox, radio or range is no
// field. (keys.spec.ts is the provider keys' journey, #144.)

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

const box = (page: Page) => page.getByRole('dialog', { name: 'Go to or do' });
const field = (page: Page) => box(page).getByRole('combobox', { name: 'Go to or do' });
const option = (page: Page, name: string) => box(page).getByRole('option', { name, exact: true });
const searchNotes = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' });
const rail = (page: Page) => page.getByRole('navigation', { name: 'Places', exact: true });
const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

/** Home, drawn, with nothing focused: the page has the keys. */
async function home(page: Page): Promise<void> {
  await page.goto('/home');
  await expect(page.getByRole('link', { name: 'Plant a thought' })).toBeVisible();
}

const ITEMS = `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}/feedItems`;

/** How many stored articles are saved, as the admin SDK would see them. */
async function savedCount(): Promise<number> {
  const res = await fetch(`${ITEMS}?pageSize=300`, { headers: { authorization: 'Bearer owner' } });
  expect(res.ok).toBe(true);
  const { documents = [] } = (await res.json()) as {
    documents?: { fields: Record<string, { booleanValue?: boolean }> }[];
  };
  expect(documents.length).toBeGreaterThan(0);
  return documents.filter((d) => d.fields['saved']?.booleanValue === true).length;
}

test.describe('at 1440 by 900', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } });

  test('/ goes to Search notes', async ({ page }) => {
    await signInAs(page, OWNER);
    await home(page);
    await page.keyboard.press('/');
    await expect(page).toHaveURL(/\/browse$/);
    await expect(searchNotes(page)).toBeFocused();
    // In the box itself `/` is a character.
    await page.keyboard.type('a/b');
    await expect(searchNotes(page)).toHaveValue('a/b');
    await expect(page).toHaveURL(/\/browse$/);
  });

  test('g then a letter goes to a place that is on', async ({ page }) => {
    await signInAs(page, OWNER);
    await home(page);
    await page.keyboard.press('g');
    await page.keyboard.press('n');
    await expect(page).toHaveURL(/\/browse$/);
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await expect(page).toHaveURL(/\/right-now$/);
    // Kitchen is off: no key, no entry, no command.
    await home(page);
    await expect(rail(page).getByRole('link', { name: /^Kitchen/ })).toHaveCount(0);
    await page.keyboard.press('g');
    await page.keyboard.press('k');
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/home$/);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(field(page)).toBeFocused();
    await field(page).fill('kitchen');
    await expect(box(page).getByRole('option')).toHaveCount(0);
    await expect(box(page)).toContainText('Nothing matches.');
    await page.keyboard.press('Escape');
    await expect(box(page)).toBeHidden();
    // Once on, it is.
    await switchModulesOn(page, 'Kitchen');
    await home(page);
    // Once the modules are read after the load: until then it is off.
    await expect(rail(page).getByRole('link', { name: /^Kitchen/ })).toBeVisible();
    await page.keyboard.press('g');
    await page.keyboard.press('k');
    await expect(page).toHaveURL(/\/(kitchen|n\/meals-\d{4}-\d{2}-\d{2})$/);
    await expect(rail(page).locator('a[aria-current="page"] .name')).toHaveText('Kitchen');
  });

  test('g then a letter from a radio button, which is no field (#313)', async ({ page }) => {
    await signInAs(page, OWNER);
    await openSettings(page, 'Start on');
    const radio = page.getByRole('radio', { name: /^Where I left off/ });
    await expect(radio).toBeChecked();
    await radio.focus();
    await expect(radio).toBeFocused();
    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await expect(page).toHaveURL(/\/home$/);
    // Focused, not chosen: the choice is as it was.
    await openSettings(page, 'Start on');
    await expect(page.getByRole('radio', { name: /^Where I left off/ })).toBeChecked();
  });

  test('in the Reader, g s is Settings, not Save', async ({ page }) => {
    test.setTimeout(120_000);
    await signInAs(page, OWNER);
    await switchModulesOn(page, 'Reader');
    await page.goto('/reader/feeds');
    await page.getByRole('textbox', { name: 'Feed link' }).fill('https://feeds.invalid/design.xml');
    await page.getByRole('combobox', { name: 'Folder' }).fill('Design');
    await page.getByRole('button', { name: 'Follow' }).click();
    await expect(page.getByRole('textbox', { name: 'Feed link' })).toHaveValue('');
    await letItSave(page);
    await page.goto('/reader/folders');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('status')).toContainText('new article', { timeout: 30_000 });

    // Three panes at this width: an article open beside the list.
    await page.goto('/reader');
    const list = page.getByRole('region', { name: 'List of articles' });
    const article = page.getByRole('region', { name: 'Article', exact: true });
    await list.locator('li[data-id] a.open').first().click();
    await expect(page).toHaveURL(/\/reader\/a\//);
    const heading = article.getByRole('heading', { level: 2 });
    await expect(heading).toBeFocused();
    const at = page.url();

    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expect(page).toHaveURL(/\/settings$/);
    await letItSave(page);
    expect(await savedCount()).toBe(0);

    // Alone, s is still the Reader's: it saves.
    await page.goto(at);
    await expect(heading).toBeVisible();
    await page.keyboard.press('s');
    await letItSave(page);
    await expect.poll(savedCount).toBe(1);
    await expect(page).toHaveURL(at);

    // `/` in the Reader is its own Search articles.
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox', { name: 'Search articles' })).toBeFocused();
    await expect(page).toHaveURL(at);
  });

  test('Ctrl K: filter, Enter goes, Escape closes', async ({ page }) => {
    await signInAs(page, OWNER);
    await home(page);
    const homeEntry = rail(page).getByRole('link', { name: /^Home(,|$)/ });
    await homeEntry.focus();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(box(page)).toBeVisible();
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(option(page, 'Go to Home')).toHaveAttribute('aria-selected', 'true');
    await expect(box(page).getByRole('list', { name: 'Keys' })).toContainText('g then a letter');
    await noSeriousViolations(page);

    // Escape: closed, the focus back on the rail's Home.
    await page.keyboard.press('Escape');
    await expect(box(page)).toBeHidden();
    await expect(homeEntry).toBeFocused();

    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('set');
    await expect(option(page, 'Settings: Appearance')).toBeVisible();
    await expect(option(page, 'Go to Notes')).toHaveCount(0);
    await page.keyboard.type(' dev');
    await expect(box(page).getByRole('option')).toHaveCount(1);
    await expect(option(page, 'Settings: This device')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(box(page)).toBeHidden();
    await expect(page).toHaveURL(/\/settings\/device$/);

    // Down moves the active one; Enter runs it.
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('notes');
    await expect(option(page, 'Go to Notes')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(option(page, 'Search notes')).toHaveAttribute('aria-selected', 'true');
    await expect(option(page, 'Go to Notes')).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/browse$/);
    await expect(searchNotes(page)).toBeFocused();
  });

  test('Ctrl K from a field, and back to it', async ({ page }) => {
    await signInAs(page, OWNER);
    await page.goto('/browse');
    await searchNotes(page).click();
    await page.keyboard.type('kiln');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(field(page)).toBeFocused();
    await page.keyboard.type('zz');
    await page.keyboard.press('Escape');
    await expect(box(page)).toBeHidden();
    await expect(searchNotes(page)).toBeFocused();
    await page.keyboard.type(' wash');
    await expect(searchNotes(page)).toHaveValue('kiln wash');
  });

  test("in the note, Ctrl K is still the editor's link", async ({ page }) => {
    await signInAs(page, OWNER);
    await openCapture(page);
    await note(page).click();
    await page.keyboard.type('Fire ');
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('kiln');
    await expect(note(page)).toHaveText('Fire [[kiln]]');
    await expect(box(page)).toBeHidden();
  });

  test('typing in the note is untouched', async ({ page }) => {
    await signInAs(page, OWNER);
    await openCapture(page);
    await note(page).click();
    const text = 'go slash / gs k then g n, gh and g/ s';
    await page.keyboard.type(text);
    await letItSave(page);
    await expect(note(page)).toHaveText(text);
    await expect(note(page)).toBeFocused();
    // Still the note: `/` or the capture note's own address once saved.
    await expect(page).toHaveURL(/\/(n\/[^/?#]+)?$/);
    await expect(box(page)).toBeHidden();
  });
});

test.describe('at 412 by 915, with a keyboard', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 412, height: 915 } });

  test('the box fits a phone', async ({ page }) => {
    await signInAs(page, OWNER);
    await home(page);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(field(page)).toBeFocused();
    const r = (await box(page).boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(412);
    expect(r.y + r.height).toBeLessThanOrEqual(915);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await noSeriousViolations(page);
    await page.keyboard.press('Escape');
    await expect(box(page)).toBeHidden();
  });
});
