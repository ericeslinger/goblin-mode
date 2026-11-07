import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SAVES_FEED_ID, feedItemId } from '@mossgoblin/schema';
import { importSaves } from './feedly';
import {
  applyRetention,
  firestoreSavesStore,
  indexItems,
  markAllDue,
  searchItems,
  sweepOld,
} from './firestore-store';
import { monthsAfter } from './refresh';
import { termsOf } from './terms';

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
    expect(await applyRetention(db, 'u1', 3, 2)).toBe(1);
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
    // Older still, behind a kept one in the page order (review on #181).
    await article('older', 400);
    await article('old-read', 120, { read: true });
    await article('old-saved', 120, { saved: true });
    await article('old-filed', 120, { noteId: 'n1' });
    await article('recent', 5);
    // Two a page: the kept ones fill the first page, the cursor reaches past them.
    expect(await sweepOld(db, 'u1', NOW - 90 * DAY, 2)).toBe(2);
    const left = (await db.collection('users/u1/feedItems').get()).docs.map((d) => d.id).sort();
    expect(left).toEqual(['old-filed', 'old-read', 'old-saved', 'recent']);
    expect(left).not.toContain('older');
    expect(await sweepOld(db, 'u1', NOW - 90 * DAY)).toBe(0);
  });
});

describe('the word index (#175)', () => {
  const indexed = (id: string, daysAgo: number, title: string, content: string) =>
    article(id, daysAgo, { title, content, terms: termsOf(title, content) });

  it('finds every article holding all the words, newest first, across pages', async () => {
    // Older than any date window: a search covers every one stored.
    await indexed('chairs-old', 900, 'Three chairs', 'Bentwood chairs, steamed.');
    await indexed('chairs', 2, 'Three chairs', 'A look at three chairs worth sitting in.');
    await indexed('chair-glaze', 1, 'A glazed chair', 'Celadon on a chair.');
    await indexed('glazes', 3, 'Celadon glazes', 'Iron in a reduction firing.');
    expect((await searchItems(db, 'u1', 'chairs')).items.map((f) => f.id)).toEqual([
      'chair-glaze',
      'chairs',
      'chairs-old',
    ]);
    expect((await searchItems(db, 'u1', 'celadon GLAZING')).items.map((f) => f.id)).toEqual([
      'chair-glaze',
      'glazes',
    ]);
    expect((await searchItems(db, 'u1', 'chair celadon')).items.map((f) => f.id)).toEqual([
      'chair-glaze',
    ]);
    expect(await searchItems(db, 'u1', 'the of', { now: NOW })).toEqual({
      items: [],
      truncated: false,
    });
    expect((await searchItems(db, 'u1', 'chairs', { limit: 1 })).items.map((f) => f.id)).toEqual([
      'chair-glaze',
    ]);
    expect(
      (await searchItems(db, 'u1', 'chairs', { since: NOW - 10 * DAY })).items.map((f) => f.id),
    ).toEqual(['chair-glaze', 'chairs']);
    expect(
      (await searchItems(db, 'u1', 'chairs', { before: NOW - 2 * DAY })).items.map((f) => f.id),
    ).toEqual(['chairs-old']);
  });

  it('reads past a page of near misses to the matches behind it', async () => {
    // Sixty newer articles hold the asked-for (longest) term but not the other.
    for (let i = 0; i < 60; i++) await indexed(`kiln-${i}`, 1, `Kilnworks ${i}`, 'Bricks.');
    await indexed('match', 5, 'Kilnworks', 'Celadon in the kiln.');
    expect((await searchItems(db, 'u1', 'kilnworks celadon')).items.map((f) => f.id)).toEqual([
      'match',
    ]);
  });

  it('indexes the articles stored before it, and those out of date, once', async () => {
    await article('bare', 10, { title: 'Celadon glazes', content: 'Iron and ash.' });
    await article('stale', 10, {
      title: 'Kilns',
      content: 'feed text',
      readerContent: 'The full essay',
      terms: ['kiln', 'feed', 'text'],
    });
    await indexed('fresh', 10, 'Chairs', 'Bentwood');
    const state = async () => (await db.doc('users/u1/usage/reader').get()).data()?.['indexedAt'];
    expect(await state()).toBeUndefined();
    expect(await indexItems(db, 'u1', 2)).toBe(2);
    // The run went through every article: search stops scanning on a miss (review on #197).
    expect(await state()).toBeInstanceOf(Timestamp);
    const terms = async (id: string) =>
      (await db.doc(`users/u1/feedItems/${id}`).get()).data()?.['terms'];
    expect(await terms('bare')).toEqual(['celadon', 'glaz', 'iron', 'ash']);
    expect(await terms('stale')).toEqual(['kiln', 'full', 'essay', 'feed', 'text']);
    expect(await indexItems(db, 'u1')).toBe(0);
    expect((await searchItems(db, 'u1', 'essay')).items.map((f) => f.id)).toEqual(['stale']);
  });
});

describe('Feedly saves (#176)', () => {
  it('writes saved, read articles once, merges tags, and makes a feed Refresh never marks due', async () => {
    const store = firestoreSavesStore(db);
    const entries = [
      { url: 'https://x.test/teapots', title: 'Teapots', tags: ['Pottery'] },
      { url: 'https://x.test/kilns', title: 'Kilns', published: NOW - DAY, tags: [] },
    ];
    expect((await importSaves(store, 'u1', entries, NOW)).added).toBe(2);
    const id = feedItemId(SAVES_FEED_ID, 'https://x.test/teapots');
    const doc = (await db.doc(`users/u1/feedItems/${id}`).get()).data()!;
    expect(doc).toMatchObject({
      saved: true,
      read: true,
      tags: ['Pottery'],
      feedId: SAVES_FEED_ID,
    });
    expect(doc['readAt']).toBeUndefined();
    // In the word index (#175), so search finds an imported save.
    expect(doc['terms']).toEqual(termsOf('Teapots', ''));
    expect((await searchItems(db, 'u1', 'teapots')).items.map((f) => f.id)).toEqual([id]);
    expect(doc['expireAt']).toBeUndefined();
    const feed = (await db.doc(`users/u1/feeds/${SAVES_FEED_ID}`).get()).data()!;
    expect(feed).toMatchObject({ url: '', title: 'Feedly saves', folders: [] });
    expect(feed['nextFetchAt']).toBeUndefined();
    // Again, with a board: known, and only the tag is new.
    await db.doc(`users/u1/feedItems/${id}`).update({ read: false });
    const again = await importSaves(
      store,
      'u1',
      [{ ...entries[0], tags: ['Glaze'] }, entries[1]],
      NOW,
    );
    expect(again).toMatchObject({ added: 0, known: 2 });
    const after = (await db.doc(`users/u1/feedItems/${id}`).get()).data()!;
    expect(after['tags']).toEqual(['Pottery', 'Glaze']);
    expect(after['read']).toBe(false);
    expect(await markAllDue(db, 'u1', NOW)).toBe(0);
  });
});
