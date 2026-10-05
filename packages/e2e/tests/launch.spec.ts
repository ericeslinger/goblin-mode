import { expect, resetAccount, test } from '../src/fixtures';

test.describe('launch', () => {
  test('opens straight into a focused editor with Right Now below', async ({ page }) => {
    await page.goto('/');
    const editor = page.getByTestId('editor');
    await expect(editor).toBeFocused();
    await expect(page.getByTestId('right-now-empty')).toHaveText('Nothing due.');
    await page.keyboard.type('buy a card');
    await expect(editor).toHaveValue('buy a card');
  });

  test('signs in against the emulator and shows the account in Settings', async ({ page }) => {
    const email = 'owner@goblin.test';
    const password = 'goblin-e2e-pass';
    await resetAccount(email, password);

    await page.goto('/dev-sign-in');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByTestId('editor')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
    await expect(page.getByTestId('version')).toContainText('e2e');
  });
});
