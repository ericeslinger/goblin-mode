import { expect, signInAs, test, openMore } from '../src/fixtures';
import { OWNER } from '../src/personas';

test('signing in shows the account and build in Settings', async ({ page }) => {
  await signInAs(page, OWNER);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);

  await (await openMore(page)).getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText(`Signed in as ${OWNER.email}`)).toBeVisible();
  await expect(page.getByText('e2e · e2e')).toBeVisible();
  // Check for updates asks the worker to look now (Eric, 2026-11-07).
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByRole('status').last()).toContainText(
    /latest version|not managed here|newer version|Could not check/,
    { timeout: 15_000 },
  );

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Not signed in.')).toBeVisible();
});
