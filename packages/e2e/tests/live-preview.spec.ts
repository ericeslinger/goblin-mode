import { expect, test } from '../src/fixtures';

// Live preview draws tasks and wiki links as widgets off the line being
// edited, and source mode shows the exact text that is stored.
//
// The widgets sit inside the editor's role=textbox, and browsers expose a
// textbox's contents as text only, so getByRole cannot reach them (nor
// can a screen reader: the keyboard path is Mod-Enter on the line). They
// are found by their aria-label within the note instead.
test('writing a task list in live preview, then checking it in source', async ({ page }) => {
  await page.goto('/');
  // Start from the default mode, whatever an earlier run left behind.
  await page.evaluate(() => localStorage.removeItem('goblin.editorMode'));
  await page.reload();

  const note = page.getByRole('textbox', { name: 'New note' });
  await expect(note).toBeFocused();
  // The phone profile has an Android user agent, and CodeMirror applies
  // Enter on Android only after the browser's own DOM change; wait for
  // each new line, as a person typing would, or the Enter can be lost.
  const lines = note.locator('.cm-line');
  await page.keyboard.type('# Groceries');
  await page.keyboard.press('Enter');
  await expect(lines).toHaveCount(2);
  await page.keyboard.type('- [ ] eggs for [[Vikas]]');
  await page.keyboard.press('Enter');
  await expect(lines).toHaveCount(3);
  await page.keyboard.type('done typing');

  // Those lines are no longer being edited: their syntax becomes widgets.
  const box = note.locator('input[aria-label="Mark done"]');
  await expect(box).toBeVisible();
  await expect(note.locator('[role=link]', { hasText: 'Vikas' })).toBeVisible();
  await expect(note).not.toContainText('# Groceries');

  await box.click();
  await expect(note.locator('input[aria-label="Mark not done"]')).toBeChecked();

  // Source mode shows the stored text, with the tick made in it.
  await page.getByRole('button', { name: 'Source' }).click();
  await expect(note).toContainText('# Groceries');
  await expect(note).toContainText('- [x] eggs for [[Vikas]]');
  await expect(note.locator('input[type=checkbox]')).toHaveCount(0);

  // The choice is remembered on the device.
  await page.reload();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('button', { name: 'Source' })).toBeVisible();
});

test('the formatting bar stays hidden without an on-screen keyboard', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'New note' })).toBeFocused();
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeHidden();
});
