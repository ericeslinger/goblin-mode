import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Viewing (2026-10-17): View draws every line and takes no typing, so a
// drag selects text without turning a line back into markdown, and a
// tap anywhere on a task's line ticks it. The note stays viewed when
// it is opened again; a new note is always for typing. Projects, one
// tap from the note, open a project's page.

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

async function noSeriousViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test('viewing a list: drag to select, tap a line to tick it', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Shopping', '- [ ] *eggs*', 'limes']);
  await letItSave(page);

  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(note(page)).toHaveAttribute('contenteditable', 'false');
  await expect(note(page)).not.toBeFocused();
  // Every line drawn, the one the caret was on (limes) too. Enter
  // carried the box onto that line.
  await expect(note(page)).not.toContainText('*');
  await expect(note(page)).not.toContainText('[ ]');

  // A tap well to the right of the box, on the line's text.
  const limes = note(page).locator('.cm-line', { hasText: 'limes' });
  await limes.getByText('limes').click();
  await expect(limes.locator('input[aria-label="Mark not done"]')).toBeChecked();

  // A drag across lines selects; it neither ticks nor shows source.
  const eggs = note(page).locator('.cm-line', { hasText: 'eggs' });
  const from = (await eggs.boundingBox())!;
  const to = (await limes.boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(eggs.locator('input[aria-label="Mark done"]')).not.toBeChecked();
  await expect(note(page)).not.toContainText('*');
  await noSeriousViolations(page);

  // Viewed again when opened again; a new note is for typing.
  await page.getByRole('button', { name: 'New' }).click();
  await expect(note(page)).toHaveAttribute('contenteditable', 'true');
  await expect(note(page)).toBeFocused();
  // Back: New made the list's history entry its own URL.
  await page.goBack();
  await expect(note(page)).toContainText('limes');
  await expect(note(page)).toHaveAttribute('contenteditable', 'false');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(note(page)).toHaveAttribute('contenteditable', 'true');
  await limes.click();
  await expect(note(page)).toContainText('- [x] limes');
});

test('Projects opens a project from the note', async ({ page }) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Wheel day for [[Pottery]]', 'soon']);
  await letItSave(page);
  await note(page).getByRole('link', { name: 'Pottery', exact: true }).click();
  await expect(page).toHaveURL(/\/n\/c-pottery$/);
  const concept = page.getByRole('region', { name: 'Concept' });
  await concept.getByRole('combobox', { name: 'Type' }).selectOption('project');
  await concept.getByRole('textbox', { name: 'Add a task' }).fill('Trim the bowls');
  await concept.getByRole('textbox', { name: 'Add a task' }).press('Enter');
  await letItSave(page);

  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('button', { name: 'Projects' }).click();
  const projects = page.getByRole('list', { name: 'Projects' });
  await expect(projects).toContainText(/Pottery\s*1 open/);
  await noSeriousViolations(page);
  await projects.getByRole('button', { name: /Pottery/ }).click();
  await expect(page).toHaveURL(/\/n\/c-pottery$/);
  await expect(concept.getByRole('list', { name: 'Tasks' })).toContainText('Trim the bowls');
});
