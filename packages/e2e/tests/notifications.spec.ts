import { expect, signInAs, test, openMore } from '../src/fixtures';
import { OWNER } from '../src/personas';

const FIRESTORE = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';

/** Every device record in the emulator, read past the rules as admin. */
async function deviceTokens(): Promise<string[]> {
  const res = await fetch(
    `http://${FIRESTORE}/v1/projects/demo-mossgoblin/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({
        structuredQuery: { from: [{ collectionId: 'devices', allDescendants: true }] },
      }),
    },
  );
  const rows = (await res.json()) as {
    document?: { fields: { token: { stringValue: string } } };
  }[];
  return rows.flatMap((r) => (r.document ? [r.document.fields.token.stringValue] : []));
}

test('turning notifications on registers this device, and off removes it', async ({
  page,
  context,
}) => {
  // Journeys run one at a time; start from no devices at all.
  await fetch(
    `http://${FIRESTORE}/emulator/v1/projects/demo-mossgoblin/databases/(default)/documents`,
    {
      method: 'DELETE',
    },
  );
  await context.grantPermissions(['notifications']);
  await signInAs(page, OWNER);
  await (await openMore(page)).getByRole('link', { name: 'Settings' }).click();
  const status = page.getByRole('status').filter({ hasText: /device|notifications/i });
  await expect(status).toHaveText('Reminders are not sent to this device.');

  await page.getByRole('button', { name: 'Turn on notifications' }).click();
  await expect(status).toHaveText('Reminders are sent to this device.');
  await expect.poll(deviceTokens).toEqual(['emulator-token']);

  // Still on after a reload: the token is refreshed, not asked for again.
  await page.reload();
  await expect(status).toHaveText('Reminders are sent to this device.');

  await page.getByRole('button', { name: 'Turn off notifications' }).click();
  await expect(status).toHaveText('Reminders are not sent to this device.');
  await expect.poll(deviceTokens).toEqual([]);
});
