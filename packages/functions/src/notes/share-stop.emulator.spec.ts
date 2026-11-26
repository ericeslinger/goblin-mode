import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SHARE_SWEEP_PAGE,
  firestoreShareStore,
  firestoreShareSweepStore,
  forgetDeletedShare,
  stopSharesOnWrite,
  sweepShares,
} from './share-stop';

// Runs inside `npm run e2e`, against the e2e Firestore emulator, under
// its own project id so it never touches journey or rules-test data:
// the share stop's Firestore adapters (review of #343).
const PROJECT = 'demo-mossgoblin-shares';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'share-stop-spec');
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

const sid = (prefix: string, n: number) =>
  `${prefix}${String(n).padStart(32 - prefix.length, '0')}`;
const exists = async (path: string) => (await db.doc(path).get()).exists;

async function shared(owner: string, noteId: string, shareId: string, note: object = {}) {
  await db.doc(`users/${owner}/notes/${noteId}`).set({ body: 'x', shareId, ...note });
  await db.doc(`shares/${shareId}`).set({ owner, noteId, kind: 'note', title: 't', body: 'b' });
}

describe('the share stop over Firestore', () => {
  it('stops a trashed note’s share and takes the id off the note', async () => {
    const A = sid('A', 1);
    await shared('u1', 'n1', A, { deletedAt: Timestamp.now() });
    const before = { shareId: A };
    const after = (await db.doc('users/u1/notes/n1').get()).data();
    expect(await stopSharesOnWrite(firestoreShareStore(db), 'u1', 'n1', before, after)).toEqual([
      A,
    ]);
    expect(await exists(`shares/${A}`)).toBe(false);
    expect((await db.doc('users/u1/notes/n1').get()).get('shareId')).toBeUndefined();
  });

  it('forgets a deleted share on its note only while the note still names it', async () => {
    const A = sid('A', 2);
    const B = sid('B', 2);
    await shared('u1', 'n1', A);
    await db.doc(`shares/${A}`).delete();
    expect(
      await forgetDeletedShare(firestoreShareStore(db), A, { owner: 'u1', noteId: 'n1' }),
    ).toBe(true);
    expect((await db.doc('users/u1/notes/n1').get()).get('shareId')).toBeUndefined();
    // Shared again since: the new id stays.
    await db.doc('users/u1/notes/n1').set({ shareId: B }, { merge: true });
    await forgetDeletedShare(firestoreShareStore(db), A, { owner: 'u1', noteId: 'n1' });
    expect((await db.doc('users/u1/notes/n1').get()).get('shareId')).toBe(B);
  });

  it('sweeps every one of the owner’s shares past a page of them, leaving other accounts’ alone', async () => {
    const batch = db.batch();
    const count = SHARE_SWEEP_PAGE + 5;
    for (let i = 0; i < count; i++) {
      const id = sid('Z', i);
      batch.set(db.doc(`users/u1/notes/n${i}`), { shareId: id });
      batch.set(db.doc(`shares/${id}`), { owner: 'u1', noteId: `n${i}` });
    }
    // The last one's note is in Trash; a stranger's share sorts first.
    batch.set(
      db.doc(`users/u1/notes/n${count - 1}`),
      { deletedAt: Timestamp.now() },
      { merge: true },
    );
    batch.set(db.doc(`shares/${sid('A', 9)}`), { owner: 'stranger', noteId: 'x' });
    await batch.commit();
    const report = await sweepShares(firestoreShareSweepStore(db), 'u1');
    expect(report).toEqual({ looked: count, removed: 1 });
    expect(await exists(`shares/${sid('Z', count - 1)}`)).toBe(false);
    expect(await exists(`shares/${sid('Z', 0)}`)).toBe(true);
    expect(await exists(`shares/${sid('A', 9)}`)).toBe(true);
  });
});
