import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Projects (#41): a concept of type project gets the project sections in
// its text, a parent, a kind and a status, its sub-projects, and tasks
// that are reminders linked to it. Browse lists projects as a tree.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });
const chip = (page: Page, name: string) => note(page).getByRole('link', { name, exact: true });

async function makeProject(page: Page, name: string): Promise<void> {
  await chip(page, name).click();
  await expect(page).toHaveURL(/\/n\/c-sprout$/);
  const concept = page.getByRole('region', { name: 'Concept' });
  await expect(concept.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name);
  await concept.getByRole('combobox', { name: 'Type' }).selectOption('project');
}

test('a project files under another, with its kind, status and tasks', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Plans', 'Work on [[Sprout]] and [[Sprout docs]] this week.', 'soon']);
  await letItSave(page);

  await makeProject(page, 'Sprout');
  const concept = page.getByRole('region', { name: 'Concept' });
  // The sections arrive in the text, in order.
  await expect(note(page)).toContainText('Overview');
  await expect(note(page)).toContainText('Open questions');
  await concept.getByRole('combobox', { name: 'Kind' }).selectOption('build');
  await concept.getByRole('combobox', { name: 'Status' }).selectOption('active');
  await letItSave(page);

  await page.goto('/n/c-sprout-docs');
  await expect(concept.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'Sprout docs',
  );
  await concept.getByRole('combobox', { name: 'Type' }).selectOption('project');
  await concept.getByRole('combobox', { name: 'Parent' }).selectOption({ label: 'Sprout' });
  await concept.getByRole('combobox', { name: 'Status' }).selectOption('waiting');
  await concept.getByRole('textbox', { name: 'Add a task' }).fill('Write the guide');
  await concept.getByRole('textbox', { name: 'Add a task' }).press('Enter');
  const tasks = concept.getByRole('list', { name: 'Tasks' });
  await expect(tasks).toContainText('Write the guide');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await tasks.getByRole('button', { name: 'Done: Write the guide' }).click();
  await expect(concept.getByRole('list', { name: 'Tasks' })).toHaveCount(0);

  // The parent lists it, with its status.
  await page.goto('/n/c-sprout');
  const children = concept.getByRole('list', { name: 'Projects in Sprout' });
  await expect(children).toContainText('Sprout docs');
  await expect(children).toContainText('Waiting');

  // Browse: the tree, then one status.
  await page.goto('/browse/projects');
  const projects = page.getByRole('list', { name: 'Projects' });
  await expect(projects.getByRole('listitem')).toHaveText([
    /Sprout\s*Build · Active/,
    /Sprout docs/,
  ]);
  await page.getByRole('combobox', { name: 'Status' }).selectOption('waiting');
  await expect(projects.getByRole('listitem')).toHaveText([/Sprout docs/]);
});
