import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyRetention, sweepOld } from './firestore-store';
import { monthsAfter } from './refresh';

// Runs inside `npm run e2e`, against the e2e Firestore emulator, under
// its own project id so it never touches journey or rules-test data.
const PROJECT = 'demo-mossgoblin-reader';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'reader-spec');
let db: Firestore;
const NOW = Date.parse('2026-11-07T12:00:00Z');
const DAY = 86_400_000;

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

async function article(id: string, daysAgo: number, more: Record<string, unknown> = {}) {
  await db.doc(`users/u1/feedItems/${id}`).set({
    feedId: 'f-1',
    title: id,
    link: `https://x.test/${id}`,
    published: Timestamp.fromMillis(NOW - daysAgo * DAY),
    summary: '',
    content: '',
    read: false,
    saved: false,
    createdAt: Timestamp.fromMillis(NOW),
    updatedAt: Timestamp.fromMillis(NOW),
    ...more,
  });
}

const expireOf = async (id: string) => {
  const v = (await db.doc(`users/u1/feedItems/${id}`).get()).data()?.['expireAt'];
  return v instanceof Timestamp ? v.toMillis() : undefined;
};

describe('retention (#171)', () => {
  it('applies the keep-for months to unsaved, unfiled articles, and clears them again', async () => {
    await article('a', 10);
    await article('saved', 10, { saved: true });
    await article('filed', 10, { noteId: 'n1' });
    expect(await applyRetention(db, 'u1', 3)).toBe(1);
    expect(await expireOf('a')).toBe(monthsAfter(NOW - 10 * DAY, 3));
    expect(await expireOf('saved')).toBeUndefined();
    expect(await expireOf('filed')).toBeUndefined();
    // The same months again touch nothing; no limit clears it.
    expect(await applyRetention(db, 'u1', 3)).toBe(0);
    expect(await applyRetention(db, 'u1', undefined)).toBe(1);
    expect(await expireOf('a')).toBeUndefined();
  });

  it('sweeps the unread, unsaved, unfiled articles older than the cutoff, and no others', async () => {
    await article('old', 120);
    await article('old-read', 120, { read: true });
    await article('old-saved', 120, { saved: true });
    await article('old-filed', 120, { noteId: 'n1' });
    await article('recent', 5);
    expect(await sweepOld(db, 'u1', NOW - 90 * DAY)).toBe(1);
    const left = (await db.collection('users/u1/feedItems').get()).docs.map((d) => d.id).sort();
    expect(left).toEqual(['old-filed', 'old-read', 'old-saved', 'recent']);
    expect(await sweepOld(db, 'u1', NOW - 90 * DAY)).toBe(0);
  });
});
