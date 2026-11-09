import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Arrange Home (#222, step 2 of #216): the Arrange Home button opens it,
// a grip moves its tile by the arrow keys, Not on Home takes a tile off,
// Done shows Home in the new order, and the order is kept in
// settings/app, so it is there after a reload, even with this device's
// copy gone.

const names = (page: Page) =>
  page.getByRole('navigation', { name: 'Modules' }).getByRole('link').locator('.name');
const arranged = (page: Page) =>
  page.getByRole('list', { name: 'Tiles, drag to reorder' }).locator(':scope > li .name');

test('Arrange Home moves a tile by keyboard, and the order is kept', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(names(page)).toHaveText(['Notes', 'Reading queue', 'Assistants', 'Map']);

  await page.getByRole('button', { name: 'Arrange Home' }).click();
  await expect(page.getByRole('heading', { name: 'Arrange Home', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done' })).toBeFocused();
  await expect(arranged(page)).toHaveText(['Notes', 'Reading queue', 'Assistants', 'Map']);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Map up a row, to beside Notes, then Assistants off Home.
  const grip = page.getByRole('button', { name: 'Move Map', exact: true });
  await grip.focus();
  await page.keyboard.press('ArrowUp');
  await expect(arranged(page)).toHaveText(['Notes', 'Map', 'Reading queue', 'Assistants']);
  await expect(grip).toBeFocused();
  await expect(page.getByText('Map, 2 of 4')).toBeAttached();
  await page.getByRole('button', { name: 'Remove Assistants' }).click();
  await expect(page.getByRole('region', { name: 'Not on Home' })).toContainText('Assistants');

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(names(page)).toHaveText(['Notes', 'Map', 'Reading queue']);
  await letItSave(page);

  await page.reload();
  await expect(names(page)).toHaveText(['Notes', 'Map', 'Reading queue']);

  // Without this device's copy, the doc brings it back. A page loaded
  // again starts a second Firestore client whose cache may be empty, so
  // this waits for the server's first answer.
  await page.evaluate(() => localStorage.removeItem('goblin.homeTiles'));
  await page.reload();
  await expect(names(page)).toHaveText(['Notes', 'Map', 'Reading queue'], { timeout: 20_000 });
});
