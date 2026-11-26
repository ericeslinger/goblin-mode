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
