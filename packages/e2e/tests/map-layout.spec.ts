import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, letItSave, openMore, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// The map on a phone (#290, step 6 of the layout pass, 2026-11-16):
// the Beds and Nearby lists lead, each row a 44 px link; the drawing
// comes after them in a box that pans and zooms, its labels drawn only
// at 11 px or more. Wide screens keep the drawing first, as before.
//
// Five concepts make five beds, three across: 720 units in a box about
// 378 px wide, so a bed's 17-unit name is about 9 px at Fit and 13 px
// a step in.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });
const beds = (page: Page) => page.getByRole('region', { name: 'Beds' });
const drawing = (page: Page) => page.getByRole('group', { name: 'Drawing', exact: true });
const zoom = (page: Page, name: 'Zoom in' | 'Zoom out' | 'Fit') =>
  page.getByRole('group', { name: 'Zoom the drawing' }).getByRole('button', { name, exact: true });
const bedNames = (page: Page) => page.locator('svg.map text.bed-label');

async function noSeriousViolations(page: Page, where: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${where}: ${v.id}: ${v.help}`)).toEqual([]);
}

/** How far the page itself scrolls sideways, in px: 0 when it does not. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Whether `first` comes before `then` in the page, as a reader meets them. */
async function before(first: Locator, then: Locator): Promise<boolean> {
  const later = await then.elementHandle();
  return first.evaluate(
    (a, b) => !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING),
    later,
  );
}

/** Three notes linking five concepts: Glaze, Kiln, Oxide, Slip and Wax. */
async function fiveBeds(page: Page): Promise<void> {
  await signInAs(page, OWNER);
  await typeLines(page, ['Studio day', 'Fire the [[Kiln]] with [[Glaze]] and [[Slip]].', 'clay']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, ['Firing log', 'The [[Kiln]] ran hot and the [[Wax]] held.', 'notes']);
  await letItSave(page);
  await page.getByRole('button', { name: 'New' }).click();
  await typeLines(page, ['Glaze recipe', 'A celadon [[Glaze]] over [[Oxide]].', 'test tile']);
  await letItSave(page);
  // Leaving the note makes its concepts.
  await page.getByRole('button', { name: 'New' }).click();
  await letItSave(page);
}

test.describe('on a phone', () => {
  test('the garden: the beds lead, the drawing zooms', async ({ page }) => {
    test.setTimeout(120_000);
    expect(page.viewportSize()).toEqual({ width: 412, height: 839 });
    await fiveBeds(page);
    await page.goto('/map');
    await expect(page.getByRole('list', { name: /^Kiln/ })).toContainText('Firing log');
    await expect(page.getByRole('list', { name: /^Glaze/ })).toContainText('Glaze recipe');
    await expect(beds(page).getByRole('heading', { level: 3 })).toHaveCount(5);
    await expect(page.locator('svg.map .node')).not.toHaveCount(0);

    // The list first, the drawing after it, in the page and on screen.
    expect(await before(beds(page), drawing(page))).toBe(true);
    const list = (await beds(page).boundingBox())!;
    const box = (await drawing(page).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(list.y + list.height);
    // No taller than 60% of the screen.
    expect(box.height).toBeLessThanOrEqual(839 * 0.6 + 3);

    // Every row a link a thumb tall: the five beds and the three notes.
    const links = beds(page).getByRole('link');
    await expect(links).toHaveCount(8);
    for (const link of await links.all()) {
      const name = (await link.textContent())!.trim();
      expect((await link.boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
    }
    for (const name of ['Zoom in', 'Zoom out', 'Fit'] as const) {
      expect((await zoom(page, name).boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
    }
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await noSeriousViolations(page, 'Fit');

    // At Fit the names would be 9 px: the marks alone.
    await expect(bedNames(page)).toHaveCount(0);
    await expect(zoom(page, 'Fit')).toBeDisabled();
    await zoom(page, 'Zoom in').click();
    await expect(bedNames(page)).toHaveText(['Glaze', 'Kiln', 'Oxide', 'Slip', 'Wax']);
    await expect(zoom(page, 'Fit')).toBeEnabled();
    // The box scrolls (the zoom keeps its middle in view), not the page.
    await expect
      .poll(() =>
        drawing(page).evaluate((el) => ({
          wider: el.scrollWidth > el.clientWidth,
          left: el.scrollLeft > 0,
        })),
      )
      .toEqual({ wider: true, left: true });
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
    await noSeriousViolations(page, 'zoomed in');

    // Fit takes the names away again.
    await zoom(page, 'Fit').click();
    await expect(bedNames(page)).toHaveCount(0);

    // A dot in the zoomed drawing still opens its note; back returns.
    await zoom(page, 'Zoom in').click();
    await page.locator('svg.map .node', { hasText: 'Firing log' }).click();
    await expect(note(page)).toContainText('Firing log');
    await page.goBack();
    await expect(page).toHaveURL(/\/map$/);
    await expect(beds(page)).toBeVisible();

    // At 320 px nothing scrolls sideways either, zoomed or not.
    await page.setViewportSize({ width: 320, height: 839 });
    await expect.poll(() => sideways(page)).toBeLessThanOrEqual(0);
    await zoom(page, 'Zoom in').click();
    await zoom(page, 'Zoom in').click();
    await expect(zoom(page, 'Zoom out')).toBeEnabled();
    await expect.poll(() => sideways(page)).toBeLessThanOrEqual(0);

    // Timeline: Over time leads, the drawing after it.
    await page.setViewportSize({ width: 412, height: 839 });
    await page
      .getByRole('navigation', { name: 'Layouts' })
      .getByRole('link', { name: 'Timeline' })
      .click();
    await expect(page).toHaveURL(/\/map\/timeline$/);
    const overTime = page.getByRole('region', { name: 'Over time' });
    await expect(overTime).toContainText('Firing log');
    expect(await before(overTime, drawing(page))).toBe(true);
    await expect(page.locator('svg.map text.lane-label')).toHaveCount(0);
    await zoom(page, 'Zoom in').click();
    await expect(page.locator('svg.map text.lane-label')).not.toHaveCount(0);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await noSeriousViolations(page, 'Timeline');
  });

  test('around a note: Nearby leads, the drawing zooms', async ({ page }) => {
    test.setTimeout(120_000);
    await fiveBeds(page);
    // A row of the garden's list opens its note.
    await page.goto('/map');
    await page
      .getByRole('list', { name: /^Kiln/ })
      .getByRole('link', { name: 'Firing log' })
      .click();
    await expect(note(page)).toContainText('Firing log');
    await (await openMore(page)).getByRole('link', { name: 'Map' }).click();
    await expect(page).toHaveURL(/\/map\/n\/\w+$/);
    await expect(page.getByRole('heading', { name: 'Around Firing log' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    const nearby = page.getByRole('region', { name: 'Nearby' });
    const direct = page.getByRole('list', { name: 'Linked directly' });
    await expect(direct).toContainText('Kiln');
    await expect(direct).toContainText('Wax');
    expect(await before(nearby, drawing(page))).toBe(true);
    for (const link of await nearby.getByRole('link').all()) {
      const name = (await link.textContent())!.trim();
      expect((await link.boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
    }
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await noSeriousViolations(page, 'Nearby');

    // 14-unit labels in a 600-unit drawing: 9 px at Fit, 13 px a step in.
    const labels = page.locator('svg.map text');
    await expect(labels).toHaveCount(0);
    await zoom(page, 'Zoom in').click();
    await expect(page.locator('svg.map text', { hasText: 'Kiln' })).toHaveCount(1);
    await expect(page.locator('svg.map text', { hasText: 'Firing log' })).toHaveCount(1);
    expect(await sideways(page)).toBeLessThanOrEqual(0);

    // A node still opens its note.
    await page.locator('svg.map .node', { hasText: 'Wax' }).click();
    await expect(page).toHaveURL(/\/n\/c-wax$/);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Around Firing log' })).toBeVisible();
  });
});

test.describe('on a wide screen', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } });

  test('the drawing first, every label, no zoom', async ({ page }) => {
    test.setTimeout(120_000);
    await fiveBeds(page);
    await page.goto('/map');
    await expect(page.getByRole('list', { name: /^Kiln/ })).toContainText('Firing log');
    const svg = page.locator('svg.map');
    await expect(svg).toBeVisible();
    // Above the list, as before #290, every bed named.
    const [art, list] = [(await svg.boundingBox())!, (await beds(page).boundingBox())!];
    expect(art.y + art.height).toBeLessThanOrEqual(list.y + 1);
    await expect(bedNames(page)).toHaveText(['Glaze', 'Kiln', 'Oxide', 'Slip', 'Wax']);
    await expect(page.getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
    await expect(drawing(page)).toHaveCount(0);
    await noSeriousViolations(page, 'wide');

    await page.locator('svg.map .node', { hasText: 'Firing log' }).click();
    await expect(note(page)).toContainText('Firing log');
  });
});
