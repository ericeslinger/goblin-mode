import { expect, signInAs, test, openMore } from '../src/fixtures';
import { OWNER } from '../src/personas';

test('signing in shows the account and build in Settings', async ({ page }) => {
  await signInAs(page, OWNER);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);

  await (await openMore(page)).getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText(`Signed in as ${OWNER.email}`)).toBeVisible();
  await expect(page.getByText('e2e · e2e')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Not signed in.')).toBeVisible();
});
