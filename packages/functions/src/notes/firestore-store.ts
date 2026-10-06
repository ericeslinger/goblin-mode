import { paths } from '@goblin/schema';
import {
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import type { HistoryStore, NoteState } from './history';
import type { TitleStore } from './title';

const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined);

/** A trigger's before or after snapshot as NoteState; undefined if absent. */
export function noteState(snap: DocumentSnapshot | undefined): NoteState | undefined {
  if (!snap?.exists) return undefined;
  const d = snap.data() ?? {};
  return {
    body: String(d['body'] ?? ''),
    title: String(d['title'] ?? ''),
    titleSource: typeof d['titleSource'] === 'string' ? d['titleSource'] : undefined,
    updatedBy: d['updatedBy'] === 'claude' ? 'claude' : 'user',
    deviceId: String(d['deviceId'] ?? ''),
    updatedAt: millis(d['updatedAt']),
    createdAt: millis(d['createdAt']),
    settledAt: millis(d['settledAt']),
  };
}

/** History and title writes over Firestore, as the admin SDK. */
export function firestoreNotesStore(db: Firestore): HistoryStore & TitleStore {
  return {
    async lastKept(uid, noteId) {
      const snap = await db
        .collection(paths.history(uid, noteId))
        .orderBy('savedAt', 'desc')
        .limit(1)
        .get();
      return millis(snap.docs[0]?.get('savedAt'));
    },

    async keep(uid, noteId, v) {
      const savedAt = FieldValue.serverTimestamp();
      // Every field the NoteVersion schema names, nothing more.
      await db.collection(paths.history(uid, noteId)).add({
        body: v.body,
        title: v.title,
        updatedBy: v.updatedBy,
        deviceId: v.deviceId,
        updatedAt: v.updatedAt === undefined ? savedAt : Timestamp.fromMillis(v.updatedAt),
        savedAt,
        reason: v.reason,
      });
    },

    setTitle(uid, noteId, forSettledAt, title) {
      const ref = db.doc(paths.note(uid, noteId));
      return db.runTransaction(async (tx) => {
        const note = await tx.get(ref);
        if (!note.exists || note.get('titleSource') === 'user') return false;
        if (millis(note.get('settledAt')) !== forSettledAt) return false;
        // Only the title: updatedAt, updatedBy and deviceId stay the writer's.
        tx.update(ref, { title, titleSource: 'llm' });
        return true;
      });
    },
  };
}
