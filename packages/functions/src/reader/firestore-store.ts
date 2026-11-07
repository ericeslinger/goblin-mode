import { FieldPath, FieldValue, type Firestore, Timestamp } from 'firebase-admin/firestore';
import { paths } from '@mossgoblin/schema';
import {
  CLAIM_MS,
  type DueFeed,
  type FeedUpdate,
  type NewItem,
  type RefreshStore,
} from './refresh';

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
          const { id, published, ...rest } = item;
          batch.set(db.doc(paths.feedItem(uid, id)), {
            ...rest,
            published: Timestamp.fromMillis(published),
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
  const live = snap.docs.filter((d) => d.data()['dead'] !== true);
  for (let at = 0; at < live.length; at += 400) {
    const batch = db.batch();
    for (const d of live.slice(at, at + 400)) {
      batch.update(d.ref, { nextFetchAt: Timestamp.fromMillis(now) });
    }
    await batch.commit();
  }
  return live.length;
}
