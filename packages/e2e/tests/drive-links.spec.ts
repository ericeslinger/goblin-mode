import { expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Google Drive links (#50): a pasted Drive link shows as a chip that
// opens the file in Drive.

test('a pasted Drive link becomes a chip that opens it in Drive', async ({ page }) => {
  await signInAs(page, OWNER);
  const url = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQr/edit';
  await typeLines(page, ['Trip plan', `See ${url}`, 'more']);
  await letItSave(page);
  const chip = page
    .getByRole('textbox', { name: 'New note' })
    .getByRole('link', { name: 'Open Google Doc in Google Drive' });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('href', url);
  await expect(chip).toHaveAttribute('target', '_blank');
});
