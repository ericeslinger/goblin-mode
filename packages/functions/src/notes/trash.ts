// The Trash sweep (#217): a note Eric deleted (`deletedAt`) goes for
// good `TRASH_DAYS` later, with everything under it (History, the
// replaced texts). Scheduled rather than a TTL policy: a TTL removes
// the document alone, never its subcollections, and needs an expiry
// field of its own beside `deletedAt` (DESIGN.md, Trash).
import { TRASH_MS } from '@mossgoblin/schema';
import { type Firestore, Timestamp } from 'firebase-admin/firestore';

/** The most notes one run removes; the rest wait for the next. */
export const TRASH_SWEEP_BATCH = 100;

/** A note in Trash, as the sweep finds it; `deletedAt` in milliseconds. */
export interface Trashed {
  path: string;
  deletedAt: number;
}

/**
 * A note read again just before it goes: its stamp, and `updateTime`,
 * when the server last wrote it, in milliseconds.
 */
export interface Reread {
  deletedAt?: number;
  updateTime: number;
}

export interface TrashStore {
  /** Up to `limit` notes, of every gardener, put in Trash at or before `cutoff`, oldest first. */
  due(cutoff: number, limit: number): Promise<Trashed[]>;
  /** The note at `path` as it stands now, or undefined when it is gone. */
  read(path: string): Promise<Reread | undefined>;
  /** Removes the note at `path` and everything under it. */
  remove(path: string): Promise<void>;
}

/** Whether a note put in Trash at `deletedAt` is due to go at `now`. */
export const dueAt = (deletedAt: number, now: number) => deletedAt + TRASH_MS <= now;

/**
 * One run: the notes in Trash `TRASH_DAYS` or longer, at most `limit`
 * of them, oldest first. Idempotent: a note gone already, or restored,
 * is skipped, and a rerun finds only what is left. `deletedAt` is the
 * device's clock, so a note goes only once the server's own
 * `updateTime` is as old too: a device set back a month cannot empty
 * Trash at once, and any later write only puts the sweep off (review
 * on #230, 2026-11-09).
 */
export async function sweepTrash(
  store: TrashStore,
  now: number,
  limit = TRASH_SWEEP_BATCH,
): Promise<{ due: number; removed: number; skipped: number }> {
  const cutoff = now - TRASH_MS;
  const found = await store.due(cutoff, limit);
  const due = found.filter((t) => dueAt(t.deletedAt, now)).slice(0, limit);
  let removed = 0;
  for (const t of due) {
    const held = await store.read(t.path);
    if (!held || held.deletedAt === undefined) continue;
    if (held.deletedAt > cutoff || held.updateTime > cutoff) continue;
    await store.remove(t.path);
    removed++;
  }
  return { due: due.length, removed, skipped: due.length - removed };
}

/** A gardener's note, `users/{uid}/notes/{id}`, not another collection named notes. */
const isNotePath = (path: string) => {
  const parts = path.split('/');
  return parts.length === 4 && parts[0] === 'users' && parts[2] === 'notes';
};

const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined);

/** The sweep over Firestore, as the admin SDK. */
export function firestoreTrashStore(db: Firestore): TrashStore {
  return {
    async due(cutoff, limit) {
      const snap = await db
        .collectionGroup('notes')
        .where('deletedAt', '<=', Timestamp.fromMillis(cutoff))
        .orderBy('deletedAt')
        .limit(limit)
        .get();
      return snap.docs.flatMap((d) => {
        const at = millis(d.get('deletedAt'));
        return isNotePath(d.ref.path) && at !== undefined
          ? [{ path: d.ref.path, deletedAt: at }]
          : [];
      });
    },

    async read(path) {
      const snap = await db.doc(path).get();
      if (!snap.exists || !snap.updateTime) return undefined;
      const at = millis(snap.get('deletedAt'));
      return {
        ...(at === undefined ? {} : { deletedAt: at }),
        updateTime: snap.updateTime.toMillis(),
      };
    },

    async remove(path) {
      // The note's subcollections first, then the note itself.
      await db.recursiveDelete(db.doc(path));
    },
  };
}
