import { expect, test } from '../src/fixtures';

test('opening the app puts the cursor in a new note, with Right Now below', async ({ page }) => {
  await page.goto('/');
  const note = page.getByRole('textbox', { name: 'New note' });
  await expect(note).toBeFocused();
  await expect(page.getByRole('region', { name: 'Right Now' })).toContainText('Nothing due.');

  await page.keyboard.type('buy a card for my nephew');
  await expect(note).toHaveText('buy a card for my nephew');
});
