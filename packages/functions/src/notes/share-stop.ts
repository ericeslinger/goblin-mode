// A note's public copy (2026-11-26; DESIGN.md, Sharing a public copy)
// stops when its note goes to Trash or is deleted, and when the note
// stops naming it. Eric's app does this itself in the same tap; this is
// the server's side of it, on every note write (noteHistory), for a
// device on an older version, or any writer that dropped the field: a
// copy no note names would be public and listed nowhere. Over a small
// interface, so it runs in specs.
import { isShareId } from '@mossgoblin/schema';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

type Data = Record<string, unknown> | undefined;

export interface ShareStore {
  /** Share `id`'s owner and note, or undefined when it is not there. */
  read(id: string): Promise<{ owner?: unknown; noteId?: unknown } | undefined>;
  remove(id: string): Promise<void>;
  /** Takes `shareId` off the note, if it still names `id`. */
  forget(uid: string, noteId: string, id: string): Promise<void>;
}

const shareOf = (data: Data) => (isShareId(data?.['shareId']) ? data['shareId'] : undefined);

/**
 * What this write to note `noteId` stops: the share it named before
 * and names no more, and the one it names while it is in Trash or
 * gone. Only a share of this owner and note is removed. Returns the ids
 * removed.
 */
export async function stopSharesOnWrite(
  store: ShareStore,
  uid: string,
  noteId: string,
  before: Data,
  after: Data,
): Promise<string[]> {
  const was = shareOf(before);
  const now = shareOf(after);
  const stop = new Set<string>();
  if (was && was !== now) stop.add(was);
  const trashed = !after || after['deletedAt'] !== undefined;
  if (now && trashed) stop.add(now);
  const removed: string[] = [];
  for (const id of stop) {
    const share = await store.read(id);
    if (share && share.owner === uid && share.noteId === noteId) {
      await store.remove(id);
      removed.push(id);
    }
  }
  if (now && trashed && after) await store.forget(uid, noteId, now);
  return removed;
}

/**
 * A share's document was deleted, by whichever device or state stopped
 * it (a locked note's Stop deletes the copy alone): its note forgets
 * the id, if it still names it, so the note and the copy cannot
 * disagree for long (review of #343).
 */
export async function forgetDeletedShare(
  store: ShareStore,
  shareId: string,
  data: Data,
): Promise<boolean> {
  const owner = data?.['owner'];
  const noteId = data?.['noteId'];
  if (!isShareId(shareId) || typeof owner !== 'string' || typeof noteId !== 'string') return false;
  if (!owner || !noteId || owner.includes('/') || noteId.includes('/')) return false;
  await store.forget(owner, noteId, shareId);
  return true;
}

/** What the daily reconciliation reads: the shares, and the note each names. */
export interface ShareSweepStore {
  /** Up to `limit` shares: id, owner and note. */
  shares(limit: number): Promise<{ id: string; owner?: unknown; noteId?: unknown }[]>;
  /** The note's `shareId` and whether it is in Trash, or undefined when it is gone. */
  note(owner: string, noteId: string): Promise<{ shareId?: unknown; trashed: boolean } | undefined>;
  remove(id: string): Promise<void>;
}

/** The most shares one daily run looks at. */
export const SHARE_SWEEP_LIMIT = 1000;

/**
 * Daily, beside the Trash sweep: every share whose note is gone, in
 * Trash, or names another share (or none) is deleted. The backstop for
 * a stop on a note write that failed (noteHistory logs it and does not
 * retry): a note in Trash never stays public longer than a day because
 * another step failed. Returns how many it removed.
 */
export async function sweepShares(
  store: ShareSweepStore,
  limit = SHARE_SWEEP_LIMIT,
): Promise<{ looked: number; removed: number }> {
  const all = await store.shares(limit);
  let removed = 0;
  for (const share of all) {
    const { owner, noteId } = share;
    const valid =
      typeof owner === 'string' &&
      owner &&
      typeof noteId === 'string' &&
      noteId &&
      !owner.includes('/') &&
      !noteId.includes('/');
    const note = valid ? await store.note(owner, noteId) : undefined;
    if (note && !note.trashed && note.shareId === share.id) continue;
    await store.remove(share.id);
    removed++;
  }
  return { looked: all.length, removed };
}

/** The reconciliation's store over Firestore, as the admin SDK. */
export function firestoreShareSweepStore(db: Firestore): ShareSweepStore {
  return {
    async shares(limit) {
      const snap = await db.collection('shares').limit(limit).get();
      return snap.docs.map((d) => ({ id: d.id, owner: d.get('owner'), noteId: d.get('noteId') }));
    },
    async note(owner, noteId) {
      const snap = await db.doc(`users/${owner}/notes/${noteId}`).get();
      if (!snap.exists) return undefined;
      return { shareId: snap.get('shareId'), trashed: snap.get('deletedAt') !== undefined };
    },
    async remove(id) {
      await db.doc(`shares/${id}`).delete();
    },
  };
}

/** The store over Firestore, as the admin SDK. */
export function firestoreShareStore(db: Firestore): ShareStore {
  return {
    async read(id) {
      const snap = await db.doc(`shares/${id}`).get();
      return snap.exists ? { owner: snap.get('owner'), noteId: snap.get('noteId') } : undefined;
    },
    async remove(id) {
      await db.doc(`shares/${id}`).delete();
    },
    async forget(uid, noteId, id) {
      const ref = db.doc(`users/${uid}/notes/${noteId}`);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.get('shareId') === id) {
          tx.update(ref, { shareId: FieldValue.delete() });
        }
      });
    },
  };
}
