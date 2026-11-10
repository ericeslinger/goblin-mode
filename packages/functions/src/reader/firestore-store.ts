import { FieldPath, FieldValue, type Firestore, Timestamp } from 'firebase-admin/firestore';
import { SAVES_FEED_ID, SAVES_FEED_TITLE, matchesSearch, paths } from '@mossgoblin/schema';
import type { SavesStore } from './feedly';
import {
  CLAIM_MS,
  type DueFeed,
  type FeedUpdate,
  type NewItem,
  type RefreshStore,
  monthsAfter,
} from './refresh';
import { queryTerms, rarestTerm, termsOfItem } from './terms';

const ms = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

/** Feeds under `users/{uid}/feeds`, items under `users/{uid}/feedItems` (#161). */
export function firestoreRefreshStore(db: Firestore): RefreshStore {
  return {
    due: async (now, limit, uid) => {
      const from = uid ? db.collection(paths.feeds(uid)) : db.collectionGroup('feeds');
      const snap = await from
        .where('nextFetchAt', '<=', Timestamp.fromMillis(now))
        .orderBy('nextFetchAt')
        .limit(limit)
        .get();
      return snap.docs.flatMap((doc) => {
        const owner = uid ?? doc.ref.parent.parent?.id;
        const d = doc.data();
        const url = str(d['url']);
        if (!owner || !url) return [];
        const feed: DueFeed = {
          uid: owner,
          id: doc.id,
          url,
          title: String(d['title'] ?? ''),
          ...(str(d['site']) ? { site: str(d['site']) } : {}),
          ...(str(d['image']) ? { image: str(d['image']) } : {}),
          ...(str(d['etag']) ? { etag: str(d['etag']) } : {}),
          ...(str(d['lastModified']) ? { lastModified: str(d['lastModified']) } : {}),
          ...(num(d['interval']) === undefined ? {} : { interval: num(d['interval']) }),
          ...(num(d['errorCount']) === undefined ? {} : { errorCount: num(d['errorCount']) }),
          ...(ms(d['lastItemAt']) === undefined ? {} : { lastItemAt: ms(d['lastItemAt']) }),
          ...(d['dead'] === true ? { dead: true } : {}),
        };
        return [feed];
      });
    },
    claim: (uid, id, now) =>
      db.runTransaction(async (tx) => {
        const ref = db.doc(paths.feed(uid, id));
        const doc = await tx.get(ref);
        if (!doc.exists) return false;
        const held = ms(doc.data()?.['claimedAt']);
        if (held !== undefined && now - held < CLAIM_MS) return false;
        tx.update(ref, { claimedAt: Timestamp.fromMillis(now) });
        return true;
      }),
    known: async (uid, ids) => {
      const out = new Set<string>();
      for (let at = 0; at < ids.length; at += 100) {
        const refs = ids.slice(at, at + 100).map((id) => db.doc(paths.feedItem(uid, id)));
        const docs = await db.getAll(...refs);
        for (const d of docs) if (d.exists) out.add(d.id);
      }
      return out;
    },
    writeItems: async (uid, items) => {
      for (let at = 0; at < items.length; at += 400) {
        const batch = db.batch();
        for (const item of items.slice(at, at + 400)) {
          const { id, published, expireAt, ...rest } = item;
          batch.set(db.doc(paths.feedItem(uid, id)), {
            ...rest,
            published: Timestamp.fromMillis(published),
            ...(expireAt === undefined ? {} : { expireAt: Timestamp.fromMillis(expireAt) }),
            read: false,
            saved: false,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        await batch.commit();
      }
    },
    updateFeed: async (uid, id, update: FeedUpdate) => {
      const fields: Record<string, unknown> = { claimedAt: FieldValue.delete() };
      for (const [k, v] of Object.entries(update)) {
        if (v === undefined) continue;
        if (v === null) fields[k] = FieldValue.delete();
        else if (k === 'fetchedAt' || k === 'nextFetchAt' || k === 'lastItemAt') {
          fields[k] = Timestamp.fromMillis(v as number);
        } else fields[k] = v;
      }
      // The feed may be gone meanwhile (removed while fetching): then the
      // items this look wrote are orphans the delete trigger ran before,
      // and go the same way (review on #166).
      await db
        .doc(paths.feed(uid, id))
        .update(fields)
        .catch(async (err: { code?: number }) => {
          if (err.code !== 5) throw err;
          await removeFeedItems(db, uid, id);
        });
    },
    keepMonths: async (uid) => {
      const doc = await db.doc(paths.reader(uid)).get();
      const months = doc.data()?.['keepMonths'];
      // Whole months, 1 to 120 (review on #181): anything else keeps everything.
      return typeof months === 'number' && Number.isInteger(months) && months >= 1 && months <= 120
        ? months
        : undefined;
    },
    countFetch: async (uid, day) => {
      await db
        .doc(paths.usage(uid, day))
        .set({ feedFetches: FieldValue.increment(1) }, { merge: true });
    },
  };
}

/**
 * Removes a feed's items that are neither saved nor filed, in pages by
 * a cursor, so filed items ahead never hide deletable ones behind them
 * (review on #166).
 */
export async function removeFeedItems(db: Firestore, uid: string, feedId: string): Promise<number> {
  let removed = 0;
  let after: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = db
      .collection(paths.feedItems(uid))
      .where('feedId', '==', feedId)
      .where('saved', '==', false)
      .orderBy(FieldPath.documentId())
      .limit(400);
    if (after) query = query.startAfter(after);
    const snap = await query.get();
    if (snap.empty) return removed;
    const docs = snap.docs.filter((d) => typeof d.data()['noteId'] !== 'string');
    if (docs.length) {
      const batch = db.batch();
      for (const d of docs) batch.delete(d.ref);
      await batch.commit();
      removed += docs.length;
    }
    if (snap.size < 400) return removed;
    after = snap.docs[snap.docs.length - 1];
  }
}

/** Marks every live feed of a gardener due now, for Refresh in the app. */
export async function markAllDue(db: Firestore, uid: string, now: number): Promise<number> {
  const snap = await db.collection(paths.feeds(uid)).get();
  // A feed with no link (the Feedly saves, #176) has nothing to look at.
  const live = snap.docs.filter((d) => d.data()['dead'] !== true && str(d.data()['url']));
  for (let at = 0; at < live.length; at += 400) {
    const batch = db.batch();
    for (const d of live.slice(at, at + 400)) {
      batch.update(d.ref, { nextFetchAt: Timestamp.fromMillis(now) });
    }
    await batch.commit();
  }
  return live.length;
}

/**
 * Applies the keep-for months (#171) to the articles already stored:
 * `expireAt` set from `published` on each unsaved, unfiled one, or
 * cleared when there is no limit. Returns how many were touched.
 */
export async function applyRetention(
  db: Firestore,
  uid: string,
  months: number | undefined,
  pageSize = 400,
): Promise<number> {
  let touched = 0;
  let after: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = db
      .collection(paths.feedItems(uid))
      .where('saved', '==', false)
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (after) query = query.startAfter(after);
    const snap = await query.get();
    if (snap.empty) return touched;
    const batch = db.batch();
    let writes = 0;
    for (const d of snap.docs) {
      const data = d.data();
      if (typeof data['noteId'] === 'string') continue;
      const published = data['published'] instanceof Timestamp ? data['published'].toMillis() : 0;
      const want =
        months && published ? Timestamp.fromMillis(monthsAfter(published, months)) : undefined;
      const have = data['expireAt'] instanceof Timestamp ? data['expireAt'] : undefined;
      if (want ? have?.isEqual(want) : have === undefined) continue;
      batch.update(d.ref, { expireAt: want ?? FieldValue.delete() });
      writes++;
    }
    if (writes) await batch.commit();
    touched += writes;
    if (snap.size < pageSize) return touched;
    after = snap.docs[snap.docs.length - 1];
  }
}

/**
 * Removes the articles that are unread, unsaved and unfiled and older
 * than `cutoff` (#171): the backlog a first import brought in. Returns
 * how many went.
 */
export async function sweepOld(
  db: Firestore,
  uid: string,
  cutoff: number,
  pageSize = 400,
): Promise<number> {
  let removed = 0;
  let after: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    // Pages by a cursor (review on #181), so kept ones (saved, filed)
    // ahead never hide deletable ones behind them.
    let query = db
      .collection(paths.feedItems(uid))
      .where('read', '==', false)
      .where('published', '<', Timestamp.fromMillis(cutoff))
      .orderBy('published', 'desc')
      .limit(pageSize);
    if (after) query = query.startAfter(after);
    const snap = await query.get();
    if (snap.empty) return removed;
    const docs = snap.docs.filter(
      (d) => d.data()['saved'] !== true && typeof d.data()['noteId'] !== 'string',
    );
    if (docs.length) {
      const batch = db.batch();
      for (const d of docs) batch.delete(d.ref);
      await batch.commit();
      removed += docs.length;
    }
    if (snap.size < pageSize) return removed;
    after = snap.docs[snap.docs.length - 1];
  }
}

/** Documents a search page reads from the index (#175). */
export const SEARCH_PAGE = 50;
/** Pages a search reads at most before it settles for what it found. */
export const SEARCH_PAGES = 5;
/** The window the scan reads when there is no index to ask (#175), as search did before it. */
export const SCAN_DAYS = 30;
/** Articles the scan reads at most, newest first (review on #197: a miss stays cheap). */
export const SCAN_MAX = 500;

/**
 * The server's own note on the word index (review on #197), beside the
 * day's usage records: `indexedAt` once a run of `indexItems` went
 * through every article, so every one stored has its terms. No rule
 * allows the owner this path (nor any under `usage`).
 */
export const indexStatePath = (uid: string) => paths.usage(uid, 'reader');

/** Whether a run of `indexItems` has gone through every article (`indexedAt` set). */
async function fullyIndexed(db: Firestore, uid: string): Promise<boolean> {
  const doc = await db.doc(indexStatePath(uid)).get();
  return doc.data()?.['indexedAt'] instanceof Timestamp;
}

/** An article search found: its id and stored fields. */
export interface FoundItem {
  id: string;
  data: FirebaseFirestore.DocumentData;
}

/**
 * What a search found (#175), and whether it stopped before it had
 * looked at everything that might match: five pages of the index read,
 * or the scan's two thousand, with more behind them.
 */
export interface SearchResult {
  items: FoundItem[];
  truncated: boolean;
}

/** A query the index cannot answer yet: its composite index is still building, or not deployed. */
const noIndex = (err: unknown) =>
  (err as { code?: unknown } | null)?.code === 9 ||
  /FAILED_PRECONDITION/.test(String((err as { message?: unknown } | null)?.message ?? err));

/**
 * Articles holding every term of `query` (#175), newest first, across
 * every one stored, by the word index: the longest term (`rarestTerm`,
 * the guess at the rarest, as there is no table of frequencies) is
 * asked for with `array-contains`, ordered by `published` desc, fifty
 * a page, and each document's own `terms` are checked for the rest,
 * until `limit` are found or five pages are read (`truncated` when
 * more were left); so a search over years costs a handful of reads.
 * `before` and `since` (millis) bound `published`.
 *
 * The scan stands in where the index cannot answer (review on #197):
 * a query of only stop words has no terms; before the composite index
 * exists the query fails with FAILED_PRECONDITION; and articles stored
 * before the index have no `terms` until `indexItems` runs, so when
 * the index finds nothing the last thirty days (or from `since`) are
 * also matched word by word (`matchesSearch`), as search did before,
 * and merged, so a freshly deployed app still finds recent articles.
 * That last scan runs only until a run of `indexItems` has gone
 * through every article (`indexedAt`, one read to know); after it a
 * miss is the index's few reads. The scan reads at most 500.
 */
export async function searchItems(
  db: Firestore,
  uid: string,
  query: string,
  options: { limit?: number; before?: number; since?: number; now?: number } = {},
): Promise<SearchResult> {
  const terms = queryTerms(query);
  const key = rarestTerm(terms);
  const limit = Math.max(1, options.limit ?? 20);
  if (!key) return scanItems(db, uid, query, limit, options);
  let indexed: SearchResult;
  try {
    indexed = await indexSearch(db, uid, key, terms, limit, options);
  } catch (err) {
    if (!noIndex(err)) throw err;
    return scanItems(db, uid, query, limit, options);
  }
  if (indexed.items.length || (await fullyIndexed(db, uid))) return indexed;
  const scanned = await scanItems(db, uid, query, limit, options);
  const seen = new Set<string>();
  const items = [...indexed.items, ...scanned.items]
    .filter((f) => !seen.has(f.id) && seen.add(f.id))
    .sort((a, b) => publishedOf(b.data) - publishedOf(a.data))
    .slice(0, limit);
  return { items, truncated: indexed.truncated || scanned.truncated };
}

const publishedOf = (d: FirebaseFirestore.DocumentData) =>
  d['published'] instanceof Timestamp ? d['published'].toMillis() : 0;

async function indexSearch(
  db: Firestore,
  uid: string,
  key: string,
  terms: string[],
  limit: number,
  options: { before?: number; since?: number },
): Promise<SearchResult> {
  const rest = terms.filter((t) => t !== key);
  let base = db
    .collection(paths.feedItems(uid))
    .where('terms', 'array-contains', key)
    .orderBy('published', 'desc');
  if (options.before !== undefined) {
    base = base.where('published', '<', Timestamp.fromMillis(options.before));
  }
  if (options.since !== undefined) {
    base = base.where('published', '>=', Timestamp.fromMillis(options.since));
  }
  const items: FoundItem[] = [];
  let after: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (let page = 0; page < SEARCH_PAGES; page++) {
    const snap = await (after ? base.startAfter(after) : base).limit(SEARCH_PAGE).get();
    for (const d of snap.docs) {
      const have = d.get('terms');
      if (!Array.isArray(have) || !rest.every((t) => have.includes(t))) continue;
      items.push({ id: d.id, data: d.data() });
      if (items.length >= limit) return { items, truncated: false };
    }
    if (snap.size < SEARCH_PAGE) return { items, truncated: false };
    after = snap.docs[snap.docs.length - 1];
  }
  // Five full pages read and more behind them: older ones were not all looked at.
  return { items, truncated: true };
}

/** The last thirty days (or from `since`), newest first, matched word by word as search did before #175. */
async function scanItems(
  db: Firestore,
  uid: string,
  query: string,
  limit: number,
  options: { before?: number; since?: number; now?: number },
): Promise<SearchResult> {
  const since = options.since ?? (options.now ?? Date.now()) - SCAN_DAYS * 86_400_000;
  let q = db
    .collection(paths.feedItems(uid))
    .where('published', '>=', Timestamp.fromMillis(since))
    .orderBy('published', 'desc');
  if (options.before !== undefined) {
    q = q.where('published', '<', Timestamp.fromMillis(options.before));
  }
  const snap = await q.limit(SCAN_MAX).get();
  const items: FoundItem[] = [];
  for (const d of snap.docs) {
    const data = d.data();
    const body = String(data['readerContent'] || data['content'] || '');
    if (!matchesSearch({ title: String(data['title'] ?? ''), body }, query)) continue;
    items.push({ id: d.id, data });
    if (items.length >= limit) return { items, truncated: false };
  }
  return { items, truncated: snap.size >= SCAN_MAX };
}

/**
 * The word index for the articles already stored (#175): `terms` set
 * on each whose terms are missing or not what its title and text give
 * now (reader mode's text included), in pages by document id, as
 * `applyRetention` pages. Returns how many were written. A run that
 * reaches the end notes `indexedAt` (`indexStatePath`): every article
 * stored now has its terms, and the fetcher and reader mode write them
 * from then on, so search stops scanning on a miss (review on #197).
 */
export async function indexItems(db: Firestore, uid: string, pageSize = 400): Promise<number> {
  let indexed = 0;
  const done = async () => {
    await db
      .doc(indexStatePath(uid))
      .set({ indexedAt: FieldValue.serverTimestamp() }, { merge: true });
    return indexed;
  };
  let after: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = db
      .collection(paths.feedItems(uid))
      .orderBy(FieldPath.documentId())
      .select('title', 'content', 'readerContent', 'terms')
      .limit(pageSize);
    if (after) query = query.startAfter(after);
    const snap = await query.get();
    if (snap.empty) return done();
    const batch = db.batch();
    let writes = 0;
    for (const d of snap.docs) {
      const data = d.data();
      const want = termsOfItem(data);
      const have = data['terms'];
      if (
        Array.isArray(have) &&
        have.length === want.length &&
        have.every((t, i) => t === want[i])
      ) {
        continue;
      }
      batch.update(d.ref, { terms: want });
      writes++;
    }
    if (writes) await batch.commit();
    indexed += writes;
    if (snap.size < pageSize) return done();
    after = snap.docs[snap.docs.length - 1];
  }
}

/**
 * The Feedly import's writes (#176): saved, read articles under
 * `feedItems`, and the feed with no link they are filed under when the
 * export names none the gardener follows.
 */
export function firestoreSavesStore(db: Firestore): SavesStore {
  return {
    followed: async (uid, feedIds) => {
      const docs = await db.getAll(...feedIds.map((id) => db.doc(paths.feed(uid, id))));
      return new Set(docs.filter((d) => d.exists).map((d) => d.id));
    },
    existing: async (uid, ids) => {
      const out = new Map<string, string[]>();
      for (let at = 0; at < ids.length; at += 100) {
        const refs = ids.slice(at, at + 100).map((id) => db.doc(paths.feedItem(uid, id)));
        for (const d of await db.getAll(...refs)) {
          if (!d.exists) continue;
          const tags = d.data()?.['tags'];
          out.set(
            d.id,
            Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
          );
        }
      }
      return out;
    },
    ensureSavesFeed: async (uid) => {
      // No url and no nextFetchAt: the tick never finds it due, and
      // Refresh skips it (markAllDue). Made once; a second create fails
      // as already there, which is the point.
      await db
        .doc(paths.feed(uid, SAVES_FEED_ID))
        .create({
          url: '',
          title: SAVES_FEED_TITLE,
          folders: [],
          addedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        })
        .catch((err: { code?: number }) => {
          if (err.code !== 6) throw err;
        });
    },
    write: async (uid, items) => {
      const docOf = (item: (typeof items)[number]) => {
        // No expireAt, ever: a saved article is kept (#171).
        const { id: _id, published, tags, expireAt: _expireAt, ...rest } = item;
        return {
          ...rest,
          published: Timestamp.fromMillis(published),
          ...(tags.length ? { tags } : {}),
          // Read, so no unread count moves, and no readAt, so the read
          // shelf's newest two hundred stay what was read.
          read: true,
          saved: true,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
      };
      for (let at = 0; at < items.length; at += 400) {
        const chunk = items.slice(at, at + 400);
        const batch = db.batch();
        // create, not set: an article stored meanwhile (a fetch, the
        // same import from another device) is left as it is.
        for (const item of chunk) batch.create(db.doc(paths.feedItem(uid, item.id)), docOf(item));
        await batch.commit().catch(async (err: { code?: number }) => {
          if (err.code !== 6) throw err;
          // One was there after all: the rest one by one.
          for (const item of chunk) {
            await db
              .doc(paths.feedItem(uid, item.id))
              .create(docOf(item))
              .catch((e: { code?: number }) => {
                if (e.code !== 6) throw e;
              });
          }
        });
      }
    },
    setTags: async (uid, updates) => {
      for (let at = 0; at < updates.length; at += 400) {
        const batch = db.batch();
        for (const u of updates.slice(at, at + 400)) {
          batch.update(db.doc(paths.feedItem(uid, u.id)), {
            tags: u.tags,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        await batch.commit();
      }
    },
  };
}
