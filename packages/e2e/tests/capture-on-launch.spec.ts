import { expect, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

test('signed out, the app shows only a way to sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New note' })).toHaveCount(0);
});

test('signed in, the cursor is in a new note, with Right Now below', async ({ page }) => {
  await signInAs(page, OWNER);
  const note = page.getByRole('textbox', { name: 'New note' });
  await expect(note).toBeFocused();
  await expect(page.getByRole('region', { name: 'Right Now' })).toContainText('Nothing to tend.');

  await page.keyboard.type('buy a card for my nephew');
  await expect(note).toHaveText('buy a card for my nephew');
});
