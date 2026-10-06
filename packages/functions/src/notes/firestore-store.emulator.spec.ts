import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { firestoreNotesStore } from './firestore-store';

// Runs inside `npm run e2e`, against the e2e Firestore emulator, under
// its own project id so it never touches journey or rules-test data.
const PROJECT = 'demo-goblin-mode-notes';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'notes-store-spec');
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

const T = Date.parse('2026-10-06T13:00:00Z');

describe('firestoreNotesStore', () => {
  it('keeps versions and reports when the newest was kept', async () => {
    const store = firestoreNotesStore(db);
    expect(await store.lastKept('u1', 'n1')).toBeUndefined();
    const version = {
      body: 'first',
      title: 'First',
      updatedBy: 'user' as const,
      deviceId: 'd1',
      updatedAt: T,
      reason: 'device' as const,
    };
    await store.keep('u1', 'n1', 'event-1', version);
    // A redelivered trigger event writes the same version, not a second.
    await store.keep('u1', 'n1', 'event-1', version);
    const all = (await db.collection('users/u1/notes/n1/history').get()).docs;
    expect(all.map((d) => d.id)).toEqual(['event-1']);
    const [kept] = (await db.collection('users/u1/notes/n1/history').get()).docs;
    expect(kept.data()).toMatchObject({
      body: 'first',
      title: 'First',
      updatedBy: 'user',
      deviceId: 'd1',
      reason: 'device',
      updatedAt: Timestamp.fromMillis(T),
    });
    expect(Object.keys(kept.data()).sort()).toEqual(
      ['body', 'deviceId', 'reason', 'savedAt', 'title', 'updatedAt', 'updatedBy'].sort(),
    );
    expect(await store.lastKept('u1', 'n1')).toBe(kept.get('savedAt').toMillis());
  });

  it('writes a title only while the note is at that settle and the title is not Eric’s', async () => {
    const store = firestoreNotesStore(db);
    const ref = db.doc('users/u1/notes/n1');
    const updatedAt = Timestamp.fromMillis(T);
    const settledAt = Timestamp.fromMillis(T + 1000);
    await ref.set({
      body: 'call the bank\nrates',
      title: 'call the bank',
      titleSource: 'words',
      updatedAt,
      settledAt,
    });

    expect(await store.setTitle('u1', 'n1', T + 1000, 'Bank call')).toBe(true);
    expect((await ref.get()).data()).toMatchObject({
      title: 'Bank call',
      titleSource: 'llm',
      updatedAt,
      settledAt,
    });

    expect(await store.setTitle('u1', 'n1', T, 'Stale')).toBe(false);
    await ref.update({ titleSource: 'user', title: 'Mine' });
    expect(await store.setTitle('u1', 'n1', T + 1000, 'Bank call')).toBe(false);
    expect(await store.setTitle('u1', 'gone', T + 1000, 'Bank call')).toBe(false);
    expect((await ref.get()).get('title')).toBe('Mine');
  });
});
