import { expect, letItSave, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Text shared from another app (#42): the manifest's share target opens
// the app at / with title, text and url, and a new note holds them.

test('text shared from another app becomes a new note', async ({ page }) => {
  await signInAs(page, OWNER);
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.share_target).toMatchObject({ action: '/', method: 'GET' });

  const params = new URLSearchParams({
    title: 'Seeds',
    text: 'what if seeds could talk',
    url: 'https://claude.ai/chat/1',
  });
  await page.goto(`/?${params}`);
  await expect(page).toHaveURL(/\/$/);
  const note = page.getByRole('textbox', { name: 'New note' });
  await expect(note).toContainText('what if seeds could talk');
  await expect(note).toContainText('https://claude.ai/chat/1');
  await letItSave(page);

  await page.goto('/browse');
  await expect(page.getByRole('list', { name: 'Notes' })).toContainText('Seeds');
});
