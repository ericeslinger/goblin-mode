import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  expect,
  letItSave,
  openMore,
  openProjectHeader,
  signInAs,
  test,
  typeLines,
  openSettings,
} from '../src/fixtures';
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
  // Its items fold to one line until opened (#287).
  await openProjectHeader(page);
  await expect(concept.getByRole('textbox', { name: 'Add a task' })).toBeVisible();
  // The write lands before the page goes (2026-11-17, #312): a reload
  // within milliseconds of the tap lost such a write under load.
  await letItSave(page);

  await openSettings(page, 'Modules');
  const projects = page.getByRole('switch', { name: 'Projects' });
  await expect(projects).toBeChecked();
  await projects.uncheck();
  await letItSave(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Pottery is still a project, so its lens would show (#288 hides
  // only empty ones): gone, it is the module that took it. Concepts,
  // which holds Pottery, stays.
  await page.goto('/browse');
  const lenses = page.getByRole('navigation', { name: 'Lenses' });
  await expect(lenses.getByRole('link', { name: /^Concepts/ })).toContainText('1');
  await expect(page.getByRole('link', { name: /Projects/ })).toHaveCount(0);
  await page.goto('/n/c-pottery');
  // Still a project in its data, shown without its project parts.
  await expect(concept.getByRole('combobox', { name: 'Type' })).toHaveValue('project');
  await expect(concept.getByRole('textbox', { name: 'Add a task' })).toHaveCount(0);
  await expect(concept.locator('button[aria-controls="project-items"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'New' }).click();
  // Projects is in More since 2026-11-15 (#287); off, not even there.
  const more = await openMore(page);
  await expect(more.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(more.getByRole('button', { name: 'Projects' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Remembered across a reload, then back on.
  await openSettings(page, 'Modules');
  await expect(projects).not.toBeChecked();
  await projects.check();
  await letItSave(page);
  await page.goto('/browse');
  await expect(lenses.getByRole('link', { name: /^Projects/ })).toContainText('1');
  await page.goto('/n/c-pottery');
  // Its items, opened before Projects went off, are open still (#287).
  await expect(concept.getByRole('textbox', { name: 'Add a task' })).toBeVisible();
});
