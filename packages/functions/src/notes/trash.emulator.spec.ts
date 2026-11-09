import { TRASH_MS } from '@mossgoblin/schema';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { firestoreTrashStore, sweepTrash } from './trash';

// Runs inside `npm run e2e`, against the e2e Firestore emulator, under
// its own project id so it never touches journey or rules-test data.
const PROJECT = 'demo-mossgoblin-trash';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'trash-sweep-spec');
let db: Firestore;

beforeAll(() => {
  process.env['FIRESTORE_EMULATOR_HOST'] = HOST;
  db = getFirestore(app);
});
beforeEach(async () => {
  const res = await fetch(
    `http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`could not clear the emulator: ${res.status}`);
});
afterAll(() => deleteApp(app));

const day = 24 * 60 * 60_000;
/**
 * The sweep's clock, a month and two days on: the server writes the
 * notes here now, so their `updateTime` is old enough by then.
 */
const NOW = Date.now() + TRASH_MS + 2 * day;

/** A note, in Trash since `deletedAt` when given, with a version and a replaced text under it. */
async function plant(path: string, deletedAt?: number) {
  await db.doc(path).set({
    body: 'Glaze notes',
    archived: false,
    ...(deletedAt === undefined ? {} : { deletedAt: Timestamp.fromMillis(deletedAt) }),
  });
  await db.doc(`${path}/history/v1`).set({ body: 'Glaze', savedAt: Timestamp.fromMillis(NOW) });
  await db.doc(`${path}/replaced/h1`).set({ body: 'Gla', writtenAt: Timestamp.fromMillis(NOW) });
}

const exists = async (path: string) => (await db.doc(path).get()).exists;

describe('the Trash sweep over Firestore (#217)', () => {
  it('removes a note 30 days in Trash with everything under it, and leaves the rest', async () => {
    await plant('users/u1/notes/old', NOW - TRASH_MS - day);
    await plant('users/u1/notes/young', NOW - 29 * day);
    await plant('users/u1/notes/live');
    await plant('users/u2/notes/theirs', NOW - 45 * day);
    const report = await sweepTrash(firestoreTrashStore(db), NOW);
    expect(report).toEqual({ due: 2, removed: 2, skipped: 0 });
    for (const gone of ['users/u1/notes/old', 'users/u2/notes/theirs']) {
      expect(await exists(gone)).toBe(false);
      expect(await exists(`${gone}/history/v1`)).toBe(false);
      expect(await exists(`${gone}/replaced/h1`)).toBe(false);
    }
    for (const kept of ['users/u1/notes/young', 'users/u1/notes/live']) {
      expect(await exists(kept)).toBe(true);
      expect(await exists(`${kept}/history/v1`)).toBe(true);
    }
    // Run again: nothing is left to do.
    expect(await sweepTrash(firestoreTrashStore(db), NOW)).toEqual({
      due: 0,
      removed: 0,
      skipped: 0,
    });
  });

  it('leaves a note restored since it was found', async () => {
    await plant('users/u1/notes/back', NOW - 40 * day);
    const store = firestoreTrashStore(db);
    const found = await store.due(NOW - TRASH_MS, 10);
    await db.doc(found[0].path).update({ deletedAt: FieldValue.delete() });
    const report = await sweepTrash({ ...store, due: async () => found }, NOW);
    expect(report).toEqual({ due: 1, removed: 0, skipped: 1 });
    expect(await exists('users/u1/notes/back/history/v1')).toBe(true);
  });

  it('leaves a note stamped 40 days back that the server wrote just now (review on #230)', async () => {
    // A device whose clock is a month and more behind.
    const now = Date.now();
    await plant('users/u1/notes/slow', now - 40 * day);
    const report = await sweepTrash(firestoreTrashStore(db), now);
    expect(report).toEqual({ due: 1, removed: 0, skipped: 1 });
    expect(await exists('users/u1/notes/slow')).toBe(true);
    expect(await exists('users/u1/notes/slow/history/v1')).toBe(true);
  });

  it('takes only a gardener’s notes, a batch at a time', async () => {
    await db.doc('other/x/notes/n1').set({ deletedAt: Timestamp.fromMillis(NOW - 50 * day) });
    for (let i = 0; i < 3; i++) await plant(`users/u1/notes/n${i}`, NOW - (40 - i) * day);
    // The first two found: the other collection's, passed over, and n0.
    const report = await sweepTrash(firestoreTrashStore(db), NOW, 2);
    expect(report).toEqual({ due: 1, removed: 1, skipped: 0 });
    expect(await exists('other/x/notes/n1')).toBe(true);
    expect(await exists('users/u1/notes/n0')).toBe(false);
    expect(await exists('users/u1/notes/n1')).toBe(true);
  });
});
