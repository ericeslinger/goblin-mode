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

test('lists continue on Enter and show bullets off the edited line', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('goblin.editorMode'));
  await page.reload();
  const note = page.getByRole('textbox', { name: 'New note' });
  const lines = note.locator('.cm-line');
  await expect(note).toBeFocused();

  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await expect(lines).toHaveCount(2);
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await expect(lines).toHaveCount(3);
  // Enter on the empty third item ends the list.
  await page.keyboard.press('Enter');
  await page.keyboard.type('after the list');

  await expect(note.locator('.gm-bullet')).toHaveCount(2);
  await page.getByRole('button', { name: 'Source' }).click();
  await expect(lines).toHaveText(['- one', '- two', 'after the list']);
  await page.getByRole('button', { name: 'Preview' }).click();
});

test('dragging the handle resizes Right Now, and it stays that size', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('goblin.rightNowShare'));
  await page.reload();
  const handle = page.getByRole('separator', { name: 'Resize Right Now' });
  await expect(handle).toHaveAttribute('aria-valuenow', '35');

  // Grab the grip and lift it by a quarter of the screen: 35% to 60%.
  const box = (await handle.boundingBox())!;
  const viewport = page.viewportSize()!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - viewport.height * 0.25, { steps: 5 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', '60');

  await page.reload();
  await expect(handle).toHaveAttribute('aria-valuenow', '60');
});

test('the formatting bar stays hidden without an on-screen keyboard', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'New note' })).toBeFocused();
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeHidden();
});
