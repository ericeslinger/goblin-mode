import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Modules (#126): switched on per user in Settings. Projects is the
// first, on until switched off; off, its type, lens and pill are gone and
// project notes stay notes.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

test('switching Projects off hides it everywhere, and on brings it back', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Wheel day for [[Pottery]]', 'soon']);
  await letItSave(page);
  await note(page).getByRole('link', { name: 'Pottery', exact: true }).click();
  const concept = page.getByRole('region', { name: 'Concept' });
  await concept.getByRole('combobox', { name: 'Type' }).selectOption('project');
  await expect(concept.getByRole('textbox', { name: 'Add a task' })).toBeVisible();

  await page.goto('/settings');
  const projects = page.getByRole('switch', { name: 'Projects' });
  await expect(projects).toBeChecked();
  await projects.uncheck();
  await letItSave(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await page.goto('/browse');
  await expect(page.getByRole('link', { name: /People/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Projects/ })).toHaveCount(0);
  await page.goto('/n/c-pottery');
  // Still a project in its data, shown without its project parts.
  await expect(concept.getByRole('combobox', { name: 'Type' })).toHaveValue('project');
  await expect(concept.getByRole('textbox', { name: 'Add a task' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.getByRole('button', { name: 'Projects' })).toHaveCount(0);

  // Remembered across a reload, then back on.
  await page.goto('/settings');
  await expect(projects).not.toBeChecked();
  await projects.check();
  await page.goto('/n/c-pottery');
  await expect(concept.getByRole('textbox', { name: 'Add a task' })).toBeVisible();
});
