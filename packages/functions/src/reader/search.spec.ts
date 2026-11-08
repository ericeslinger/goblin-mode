import { type Firestore, Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { SEARCH_PAGE, SEARCH_PAGES, searchItems } from './firestore-store';
import { termsOf } from './terms';

// searchItems over a stand-in Firestore (review on #197): the index
// missing, nothing indexed yet, and a search that runs out of pages.
const NOW = Date.parse('2026-11-07T12:00:00Z');
const DAY = 86_400_000;

type Doc = { id: string; data: Record<string, unknown> };

const article = (id: string, daysAgo: number, title: string, content: string, idx = true): Doc => ({
  id,
  data: {
    title,
    content,
    published: Timestamp.fromMillis(NOW - daysAgo * DAY),
    ...(idx ? { terms: termsOf(title, content) } : {}),
  },
});

/** Just the queries searchItems makes; `noIndex` fails the array-contains one as Firestore does. */
function fakeDb(docs: Doc[], noIndex = false, indexedAt?: Timestamp) {
  const reads: string[] = [];
  const query = (
    filters: ((d: Doc) => boolean)[],
    contains: boolean,
    n = Infinity,
    after?: string,
  ) => ({
    where(field: string, op: string, value: unknown) {
      const pass = (d: Doc) => {
        const v = d.data[field];
        if (op === 'array-contains') return Array.isArray(v) && v.includes(value);
        const ms = (v as Timestamp).toMillis();
        const at = (value as Timestamp).toMillis();
        return op === '>=' ? ms >= at : ms < at;
      };
      return query([...filters, pass], contains || op === 'array-contains', n, after);
    },
    orderBy: () => query(filters, contains, n, after),
    limit: (m: number) => query(filters, contains, m, after),
    startAfter: (d: { id: string }) => query(filters, contains, n, d.id),
    async get() {
      reads.push(contains ? 'index' : 'scan');
      if (contains && noIndex) {
        throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), {
          code: 9,
        });
      }
      let list = docs
        .filter((d) => filters.every((f) => f(d)))
        .sort(
          (a, b) =>
            (b.data['published'] as Timestamp).toMillis() -
            (a.data['published'] as Timestamp).toMillis(),
        );
      if (after) list = list.slice(list.findIndex((d) => d.id === after) + 1);
      const page = list.slice(0, n).map((d) => ({
        id: d.id,
        data: () => d.data,
        get: (f: string) => d.data[f],
      }));
      return { docs: page, size: page.length, empty: !page.length };
    },
  });
  const db = {
    collection: () => query([], false),
    // The server's note on the index (`indexStatePath`).
    doc: (path: string) => ({
      async get() {
        reads.push(`doc ${path}`);
        return { data: () => (indexedAt ? { indexedAt } : undefined) };
      },
    }),
  };
  return { db: db as unknown as Firestore, reads };
}

const ids = (r: { items: { id: string }[] }) => r.items.map((f) => f.id);

describe('searchItems where the index cannot answer (#175, review on #197)', () => {
  it('scans the last thirty days word by word while the composite index is missing', async () => {
    const { db, reads } = fakeDb(
      [article('recent', 2, 'Three chairs', 'Bentwood.'), article('old', 90, 'Chairs', 'Old.')],
      true,
    );
    const found = await searchItems(db, 'u1', 'chairs', { now: NOW });
    expect(ids(found)).toEqual(['recent']);
    expect(found.truncated).toBe(false);
    expect(reads).toEqual(['index', 'scan']);
  });

  it('merges the recent scan when the index finds nothing, newest first, once each', async () => {
    const { db } = fakeDb([
      // Stored before the index: no terms yet.
      article('fresh', 1, 'Celadon glazes', 'Iron.', false),
      article('older', 5, 'More celadon', 'Ash.', false),
      article('ancient', 400, 'Celadon', 'Long ago.', false),
      article('other', 1, 'Kilns', 'Bricks.'),
    ]);
    const found = await searchItems(db, 'u1', 'celadon', { now: NOW });
    expect(ids(found)).toEqual(['fresh', 'older']);
    expect(found.items[0].data['title']).toBe('Celadon glazes');
  });

  it('scans no more on a miss once a run has indexed every article', async () => {
    const docs = [article('bare', 1, 'Celadon glazes', 'Iron.', false)];
    const before = fakeDb(docs);
    expect(ids(await searchItems(before.db, 'u1', 'celadon', { now: NOW }))).toEqual(['bare']);
    expect(before.reads).toEqual(['index', 'doc users/u1/usage/reader', 'scan']);
    const after = fakeDb(docs, false, Timestamp.fromMillis(NOW));
    expect(await searchItems(after.db, 'u1', 'celadon', { now: NOW })).toEqual({
      items: [],
      truncated: false,
    });
    expect(after.reads).toEqual(['index', 'doc users/u1/usage/reader']);
    // The other fallbacks stay: the index missing, and only stop words.
    const missing = fakeDb(docs, true, Timestamp.fromMillis(NOW));
    expect(ids(await searchItems(missing.db, 'u1', 'celadon', { now: NOW }))).toEqual(['bare']);
    const stop = fakeDb([article('a', 1, 'The kiln', 'Of it.')], false, Timestamp.fromMillis(NOW));
    expect(ids(await searchItems(stop.db, 'u1', 'of the', { now: NOW }))).toEqual(['a']);
  });

  it('keeps to the index when it finds something', async () => {
    const { db, reads } = fakeDb([
      article('indexed', 3, 'Celadon', 'Green.'),
      article('bare', 1, 'Celadon too', 'Not yet.', false),
    ]);
    expect(ids(await searchItems(db, 'u1', 'celadon', { now: NOW }))).toEqual(['indexed']);
    expect(reads).toEqual(['index']);
  });

  it('scans for a query of only stop words', async () => {
    const { db, reads } = fakeDb([article('a', 1, 'The kiln', 'Of the fire.')]);
    expect(ids(await searchItems(db, 'u1', 'of the', { now: NOW }))).toEqual(['a']);
    expect(reads).toEqual(['scan']);
  });

  it('says when it stopped after five pages with older ones left', async () => {
    // Near misses fill every page: the asked-for term without the other.
    const misses = Array.from({ length: SEARCH_PAGE * SEARCH_PAGES + 1 }, (_, i) =>
      article(`m${i}`, 1 + i / 1000, 'Kilnworks', 'Bricks.'),
    );
    const { db } = fakeDb([...misses, article('match', 200, 'Kilnworks', 'Celadon.')]);
    const found = await searchItems(db, 'u1', 'kilnworks celadon', { now: NOW });
    expect(found.truncated).toBe(true);
    // Nothing found in the index, so the recent scan ran too; the match is older than that.
    expect(ids(found)).toEqual([]);
    const few = fakeDb([...misses.slice(0, 10), article('match', 200, 'Kilnworks', 'Celadon.')]);
    const all = await searchItems(few.db, 'u1', 'kilnworks celadon', { now: NOW });
    expect(ids(all)).toEqual(['match']);
    expect(all.truncated).toBe(false);
  });

  it('passes any other failure on', async () => {
    const db = {
      collection: () => {
        throw new Error('permission denied');
      },
    } as unknown as Firestore;
    await expect(searchItems(db, 'u1', 'chairs')).rejects.toThrow('permission denied');
  });
});
