import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// axe over every surface, WCAG 2.1 A and AA; serious and critical
// violations fail the run. No exclusions yet.
async function expectNoSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

test('every screen passes axe, signed out and signed in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  await expectNoSeriousViolations(page);

  await page.goto('/dev-sign-in');
  await expectNoSeriousViolations(page);

  await signInAs(page, OWNER);
  await page.keyboard.type('A note for the lists');
  await page.waitForTimeout(800);
  await expectNoSeriousViolations(page);

  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('button', { name: 'Previous note' }).click();
  await expectNoSeriousViolations(page);

  await page.goto('/browse');
  await expect(page.getByRole('list', { name: 'Notes' })).toBeVisible();
  await expectNoSeriousViolations(page);

  await page.goto('/right-now');
  await page.getByRole('button', { name: 'Add a reminder' }).click();
  await expectNoSeriousViolations(page);
  await page.getByRole('textbox', { name: 'Reminder', exact: true }).fill('Water the plants');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Snooze: Water the plants' }).click();
  await expectNoSeriousViolations(page);
  await page.getByRole('button', { name: 'Done: Water the plants' }).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expectNoSeriousViolations(page);

  await page.goto('/');
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(page.getByRole('complementary', { name: 'All notes' })).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.setViewportSize({ width: 412, height: 839 });

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expectNoSeriousViolations(page);
});
