import AxeBuilder from '@axe-core/playwright';
import { type Page, devices } from '@playwright/test';
import { expect, prepPage, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

const THEMES = ['Herbarium', 'Night Garden', 'Moss and Lantern', 'Bog Goblin', 'Pixel Mossling'];

async function pick(page: Page, theme: string, mode: 'Light' | 'Dark'): Promise<void> {
  await page.getByRole('radio', { name: new RegExp(`^${theme}`) }).check();
  await page.getByRole('radio', { name: mode, exact: true }).check();
}

async function expectNoSeriousViolations(page: Page, where: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${where}: ${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

test('a theme chosen in Settings applies at once and survives a reload', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('radio', { name: /^Herbarium/ })).toBeChecked();

  await pick(page, 'Night Garden', 'Dark');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'night');
  await expect(html).toHaveAttribute('data-mode', 'dark');

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'night');
  await expect(page.getByRole('radio', { name: /^Night Garden/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
});

test('a theme chosen on one device follows the gardener to another', async ({ page, browser }) => {
  await signInAs(page, OWNER);
  await page.getByRole('link', { name: 'Settings' }).click();
  await pick(page, 'Pixel Mossling', 'Dark');

  const other = await browser.newContext({ ...devices['Pixel 7'] });
  const second = await other.newPage();
  await prepPage(second);
  await signInAs(second, OWNER, { reset: false });
  const html = second.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'pixel');
  await expect(html).toHaveAttribute('data-mode', 'dark');

  // And back the other way.
  await second.goto('/settings');
  await pick(second, 'Moss and Lantern', 'Light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'moss');
  await other.close();
});

test('every theme, light and dark, passes axe on the busiest screens', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAs(page, OWNER);
  await page.keyboard.type('Groceries for the week');
  // Past the autosave delay, so the note is written before we leave.
  await page.waitForTimeout(800);
  await page.goto('/right-now');
  await page.getByRole('button', { name: 'Add a reminder' }).click();
  await page.getByRole('textbox', { name: 'Reminder', exact: true }).fill('Water the plants');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Water the plants')).toBeVisible();

  for (const theme of THEMES) {
    for (const mode of ['Light', 'Dark'] as const) {
      await page.goto('/settings');
      await pick(page, theme, mode);
      await expectNoSeriousViolations(page, `${theme} ${mode} Settings`);
      await page.goto('/right-now');
      await expect(page.getByText('Water the plants')).toBeVisible();
      await expectNoSeriousViolations(page, `${theme} ${mode} Right Now`);
      await page.goto('/browse');
      await expect(page.getByRole('list', { name: 'Notes' })).toBeVisible();
      await expectNoSeriousViolations(page, `${theme} ${mode} Browse`);
    }
  }
});
