import { type Page, devices } from '@playwright/test';
import {
  FIRESTORE_EMULATOR as FIRESTORE,
  expect,
  letItSave,
  prepPage,
  signInAs,
  test,
  typeLines,
  openMore,
} from '../src/fixtures';
import { OWNER } from '../src/personas';
import { DEV_NOTE_KEYS_MASTER } from '../../functions/src/note-keys/dev-master.emulator';
import { deriveNoteKey, masterFromBase64 } from '../../schema/src/note-key';
import { type DataKey, aadFor, importDataKey, openText } from '../../schema/src/sealed';

const note = (page: Page) => page.getByRole('textbox', { name: 'New note' });

// noteHistory runs in the e2e functions emulator, so a write from a
// second device keeps the first device's version for real.
test('a version another device wrote over can be found in History and restored', async ({
  page,
  browser,
}) => {
  await signInAs(page, OWNER);
  await typeLines(page, ['Groceries: milk, eggs']);
  await letItSave(page);

  const other = await browser.newContext({ ...devices['Pixel 7'] });
  const second = await other.newPage();
  await prepPage(second);
  await signInAs(second, OWNER, { reset: false });
  await second.goto('/browse');
  await second
    .getByRole('list', { name: 'Notes' })
    .getByRole('link', { name: /Groceries/ })
    .click();
  await expect(note(second)).toContainText('Groceries: milk, eggs');
  await note(second).click();
  await second.keyboard.press('ControlOrMeta+a');
  await second.keyboard.type('Groceries: oat milk');
  await letItSave(second);
  await other.close();

  await page.reload();
  await expect(note(page)).toContainText('Groceries: oat milk');
  await (await openMore(page)).getByRole('link', { name: 'History' }).click();
  const versions = page.getByRole('list', { name: 'Earlier versions' });
  const kept = versions.getByRole('button', { name: /Groceries: milk, eggs/ });
  await expect(kept).toContainText('Written over from another device');
  await kept.click();
  await page.getByRole('button', { name: 'Restore this version' }).click();

  await expect(note(page)).toHaveText('Groceries: milk, eggs');
  await letItSave(page);
  await page.reload();
  await expect(note(page)).toHaveText('Groceries: milk, eggs');
  // The text the restore replaced is kept in turn.
  await (await openMore(page)).getByRole('link', { name: 'History' }).click();
  await expect(
    page.getByRole('list', { name: 'Earlier versions' }).getByRole('button', { name: /oat milk/ }),
  ).toBeVisible();
});

/** The owner's data key, derived from the development master, as the stand-ins do. */
async function ownerKey(): Promise<DataKey> {
  const master = masterFromBase64(DEV_NOTE_KEYS_MASTER);
  if (!master) throw new Error('no development master');
  return importDataKey(await deriveNoteKey(master, OWNER.uid, 1));
}

/**
 * Every note in the emulator with its body and settledAt, read as admin;
 * the body is stored sealed (always sealed, 2026-11-15) and opened here
 * with the owner's key.
 */
async function storedNotes(): Promise<{ body: string; settled: boolean }[]> {
  const key = await ownerKey();
  const res = await fetch(
    `http://${FIRESTORE}/v1/projects/demo-mossgoblin/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({
        structuredQuery: { from: [{ collectionId: 'notes', allDescendants: true }] },
      }),
    },
  );
  const rows = (await res.json()) as {
    document?: {
      name: string;
      fields: { body?: { stringValue: string }; settledAt?: unknown };
    };
  }[];
  return rows.flatMap((r) => {
    if (!r.document) return [];
    const id = r.document.name.split('/').pop()!;
    const stored = r.document.fields.body?.stringValue ?? '';
    return [
      {
        body: openText(key, aadFor(OWNER.uid, id, 'body'), stored),
        settled: !!r.document.fields.settledAt,
      },
    ];
  });
}

test('leaving a note settles it, which is what asks for a Claude title', async ({ page }) => {
  await fetch(
    `http://${FIRESTORE}/emulator/v1/projects/demo-mossgoblin/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  await signInAs(page, OWNER);
  await typeLines(page, ['Ask the bank about loan rates']);
  await letItSave(page);
  await expect
    .poll(storedNotes)
    .toEqual([{ body: 'Ask the bank about loan rates', settled: false }]);

  await page.getByRole('button', { name: 'New' }).click();
  await expect
    .poll(storedNotes)
    .toEqual([{ body: 'Ask the bank about loan rates', settled: true }]);
});
