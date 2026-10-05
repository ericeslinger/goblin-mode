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
  await expect(page.getByRole('textbox', { name: 'New note' })).toBeVisible();
  await expectNoSeriousViolations(page);

  await page.goto('/dev-sign-in');
  await expectNoSeriousViolations(page);

  await signInAs(page, OWNER);
  await expectNoSeriousViolations(page);

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expectNoSeriousViolations(page);
});
