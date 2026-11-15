import { DEV_NOTE_KEYS_MASTER } from '../../functions/src/note-keys/dev-master.emulator';
import { deriveNoteKey, masterFromBase64 } from '../../schema/src/note-key';
import {
  type DataKey,
  aadFor,
  importDataKey,
  isSealed,
  openSealedText,
} from '../../schema/src/sealed';
import { connectClaude } from '../src/claude';
import { FIRESTORE_EMULATOR, expect, letItSave, signInAs, test, typeLines } from '../src/fixtures';
import { OWNER } from '../src/personas';

// Always sealed (Eric, 2026-11-15, after the migration; DESIGN.md, Note
// encryption, Always sealed): there is no switch. A fresh sign-in gets
// its key from the e2e static server's `/api/note-key` stand-in, and the
// first note it types is stored sealed, body and title; a reload reads
// it, and Claude reads it through MCP. A note written plain straight
// into the emulator, standing in for an out-of-date app's write, is
// sealed by noteHistory shortly after, with the functions emulator's
// stand-in key, and still opens in the app.

const NOTES = `http://${FIRESTORE_EMULATOR}/v1/projects/demo-mossgoblin/databases/(default)/documents/users/${OWNER.uid}/notes`;
const ADMIN = { authorization: 'Bearer owner' };

type Fields = Record<string, { stringValue?: string }>;
type StoredDoc = { name: string; fields?: Fields };

/** The owner's data key, derived from the development master, as both stand-ins do. */
async function ownerKey(): Promise<DataKey> {
  const master = masterFromBase64(DEV_NOTE_KEYS_MASTER);
  if (!master) throw new Error('no development master');
  return importDataKey(await deriveNoteKey(master, OWNER.uid, 1));
}

/** Every note document as stored, read as admin. */
async function storedNotes(): Promise<StoredDoc[]> {
  const res = await fetch(`${NOTES}?pageSize=300`, { headers: ADMIN });
  const { documents = [] } = (await res.json()) as { documents?: StoredDoc[] };
  return documents;
}

const idOf = (doc: StoredDoc) => doc.name.split('/').pop()!;
const text = (doc: StoredDoc | undefined, field: string) => doc?.fields?.[field]?.stringValue;

test('a fresh sign-in writes sealed from the first keystroke, and a plain write is sealed by the server', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const key = await ownerKey();
  const open = (id: string, field: 'body' | 'title', value: string | undefined) =>
    openSealedText(key, aadFor(OWNER.uid, id, field), String(value));

  await signInAs(page, OWNER);
  await typeLines(page, ['Plumber on Tuesday', 'bring the spare key']);
  await letItSave(page);
  await expect(page.getByRole('status')).toHaveText('synced');

  // Stored sealed, body and title, the words nowhere in the clear.
  const typed = async () => {
    for (const d of await storedNotes()) {
      const body = text(d, 'body');
      if (isSealed(body) && open(idOf(d), 'body', body).startsWith('Plumber on Tuesday')) return d;
    }
    return undefined;
  };
  await expect
    .poll(async () => {
      const d = await typed();
      return d && open(idOf(d), 'body', text(d, 'body'));
    })
    .toBe('Plumber on Tuesday\nbring the spare key');
  const doc = (await typed())!;
  const id = idOf(doc);
  expect(isSealed(text(doc, 'title'))).toBe(true);
  expect(open(id, 'title', text(doc, 'title'))).toBe('Plumber on Tuesday');
  expect(JSON.stringify(await storedNotes())).not.toMatch(/Plumber|spare key/);

  // A reload reads it back.
  await page.reload();
  await page.goto('/browse');
  const list = page.getByRole('list', { name: 'Notes' });
  await list.getByRole('link', { name: /Plumber on Tuesday/ }).click();
  await expect(page.getByRole('textbox', { name: 'New note' })).toContainText(
    'bring the spare key',
  );

  // Claude reads it through MCP, opened by the functions' own key.
  const call = await connectClaude(page);
  const read = (await call('get_note', { id })) as { body: string; title: string };
  expect(read).toMatchObject({
    body: 'Plumber on Tuesday\nbring the spare key',
    title: 'Plumber on Tuesday',
  });

  // An out-of-date app writes a note plain, past the app (as admin).
  const PLAIN = 'PlainFromAnOldApp01';
  const now = new Date().toISOString();
  const res = await fetch(`${NOTES}/${PLAIN}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...ADMIN },
    body: JSON.stringify({
      fields: {
        body: { stringValue: 'Written by an old app\nstill plain' },
        title: { stringValue: 'Written by an old app' },
        titleSource: { stringValue: 'words' },
        kind: { stringValue: 'text' },
        links: { arrayValue: {} },
        tags: { arrayValue: {} },
        archived: { booleanValue: false },
        createdAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
        updatedBy: { stringValue: 'user' },
        deviceId: { stringValue: 'old-app' },
      },
    }),
  });
  if (!res.ok) throw new Error(`could not write the plain note: ${await res.text()}`);

  // noteHistory seals it shortly after: every field, the text the same.
  const plainDoc = async () => (await storedNotes()).find((d) => idOf(d) === PLAIN);
  await expect
    .poll(async () => isSealed(text(await plainDoc(), 'body')), { timeout: 30_000 })
    .toBe(true);
  const sealed = (await plainDoc())!;
  expect(isSealed(text(sealed, 'title'))).toBe(true);
  expect(open(PLAIN, 'body', text(sealed, 'body'))).toBe('Written by an old app\nstill plain');
  expect(open(PLAIN, 'title', text(sealed, 'title'))).toBe('Written by an old app');
  // A write of form alone: whoever wrote it is still who wrote it.
  expect(text(sealed, 'deviceId')).toBe('old-app');
  expect(JSON.stringify(sealed)).not.toContain('still plain');

  // And it opens in the app as ever.
  await page.goto('/browse');
  await expect(list).toContainText('Written by an old app');
});
