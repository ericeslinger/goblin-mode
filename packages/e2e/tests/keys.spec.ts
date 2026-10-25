import { FIRESTORE_EMULATOR, expect, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

const KEY = 'sk-ant-api03-e2e-abcdefghijklmnopqrstuvwxyz0123';

/** A document straight from the emulator, as the admin SDK would see it. */
async function stored(path: string): Promise<string> {
  const res = await fetch(
    `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/${path}`,
    { headers: { authorization: 'Bearer owner' } },
  );
  return res.text();
}

// A gardener's own provider key (#144): pasted in Settings, kept by the
// saveKey callable sealed under secrets/{uid}, shown back masked only,
// and removed with removeKey.
test('a pasted provider key is kept sealed, shown masked, and removed', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/settings');
  const keys = page.getByRole('list', { name: 'API keys' });
  await keys.getByRole('textbox', { name: 'Anthropic key' }).fill(KEY);
  await keys.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'saved' })).toContainText(
    'Anthropic key sk-ant-…0123 saved.',
  );
  await expect(keys).toContainText('sk-ant-…0123');
  await expect(keys.getByRole('textbox', { name: 'Anthropic key' })).toHaveCount(0);

  // The key itself is nowhere the app can read, and sealed where it is.
  const secret = await stored(`secrets/${OWNER.uid}`);
  expect(secret).toContain('ciphertext');
  expect(secret).not.toContain(KEY);
  expect(await stored(`users/${OWNER.uid}/settings/keys`)).not.toContain(KEY);

  await page.reload();
  await expect(keys).toContainText('sk-ant-…0123');
  await keys.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'removed' })).toContainText(
    'revoke it at Anthropic too',
  );
  await expect(keys.getByRole('textbox', { name: 'Anthropic key' })).toBeVisible();
  expect(await stored(`secrets/${OWNER.uid}`)).not.toContain('ciphertext');
});
