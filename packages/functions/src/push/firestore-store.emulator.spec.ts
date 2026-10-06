import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { firestoreStore } from './firestore-store';

// Runs inside `npm run e2e`, against the e2e Firestore emulator, under
// its own project id so it never touches journey or rules-test data.
const PROJECT = 'demo-goblin-mode-push';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'push-store-spec');
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

const at = (ms: number) => Timestamp.fromMillis(ms);
const T = Date.parse('2026-10-06T13:00:00Z');

describe('firestoreStore', () => {
  it('finds due reminders across users, oldest first, and reads their fields', async () => {
    await db.doc('users/a/reminders/r1').set({
      text: 'Journal',
      status: 'open',
      createdBy: 'user',
      dueAt: at(T),
      nextFireAt: at(T),
      recurrence: { freq: 'daily', time: '09:00', tz: 'America/New_York' },
      noteId: 'n1',
    });
    await db.doc('users/b/reminders/r2').set({
      text: 'Call the bank',
      status: 'snoozed',
      createdBy: 'claude',
      snoozedUntil: at(T - 60_000),
      nextFireAt: at(T - 60_000),
    });
    await db.doc('users/a/reminders/later').set({
      text: 'Later',
      status: 'open',
      createdBy: 'user',
      nextFireAt: at(T + 60_000),
    });
    await db.doc('users/a/reminders/someday').set({
      text: 'Someday',
      status: 'open',
      createdBy: 'user',
    });

    const due = await firestoreStore(db).due(T, 10);
    expect(due).toEqual([
      {
        uid: 'b',
        id: 'r2',
        text: 'Call the bank',
        status: 'snoozed',
        dueAt: undefined,
        snoozedUntil: T - 60_000,
        nextFireAt: T - 60_000,
        recurrence: undefined,
        noteId: undefined,
      },
      {
        uid: 'a',
        id: 'r1',
        text: 'Journal',
        status: 'open',
        dueAt: T,
        snoozedUntil: undefined,
        nextFireAt: T,
        recurrence: { freq: 'daily', time: '09:00', tz: 'America/New_York' },
        noteId: 'n1',
      },
    ]);
    expect(await firestoreStore(db).due(T, 1)).toHaveLength(1);
  });

  it('claims once: moves or removes nextFireAt, and refuses a stale claim', async () => {
    const store = firestoreStore(db);
    await db.doc('users/a/reminders/r1').set({
      text: 'Journal',
      status: 'open',
      createdBy: 'user',
      nextFireAt: at(T),
    });
    const [r] = await store.due(T, 10);
    expect(await store.claim(r, T, T + 86_400_000)).toBe(true);
    expect((await db.doc('users/a/reminders/r1').get()).get('nextFireAt').toMillis()).toBe(
      T + 86_400_000,
    );
    // A second run holding the old value gets nothing.
    expect(await store.claim(r, T, undefined)).toBe(false);

    expect(await store.claim(r, T + 86_400_000, undefined)).toBe(true);
    const after = await db.doc('users/a/reminders/r1').get();
    expect(after.get('nextFireAt')).toBeUndefined();
    expect(after.get('text')).toBe('Journal');
  });

  it('lists devices with tokens and removes one', async () => {
    const store = firestoreStore(db);
    await db.doc('users/a/devices/d1').set({ token: 't1', updatedAt: at(T) });
    await db.doc('users/a/devices/d2').set({ token: '', updatedAt: at(T) });
    expect(await store.devices('a')).toEqual([{ id: 'd1', token: 't1' }]);
    await store.removeDevice('a', 'd1');
    expect(await store.devices('a')).toEqual([]);
  });
});
