import { firstWordsTitle, paths, textHash } from '@mossgoblin/schema';
import {
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import type { HistoryStore, NoteState } from './history';
import { MERGE_DEVICE, type MergeStore, REPLACED_KEPT } from './merge';
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
    baseHash: typeof d['baseHash'] === 'string' ? d['baseHash'] : undefined,
  };
}

/** History and title writes over Firestore, as the admin SDK. */
export function firestoreNotesStore(db: Firestore): HistoryStore & TitleStore & MergeStore {
  return {
    async lastKept(uid, noteId) {
      const snap = await db
        .collection(paths.history(uid, noteId))
        .orderBy('savedAt', 'desc')
        .limit(1)
        .get();
      return millis(snap.docs[0]?.get('savedAt'));
    },

    async keep(uid, noteId, versionId, v) {
      const savedAt = FieldValue.serverTimestamp();
      // Every field the NoteVersion schema names, nothing more.
      await db.doc(`${paths.history(uid, noteId)}/${versionId}`).set({
        body: v.body,
        title: v.title,
        updatedBy: v.updatedBy,
        deviceId: v.deviceId,
        updatedAt: v.updatedAt === undefined ? savedAt : Timestamp.fromMillis(v.updatedAt),
        savedAt,
        reason: v.reason,
      });
    },

    async keptBodies(uid, noteId, limit) {
      const [replaced, kept] = await Promise.all([
        db
          .collection(paths.replaced(uid, noteId))
          .orderBy('writtenAt', 'desc')
          .limit(REPLACED_KEPT)
          .get(),
        db.collection(paths.history(uid, noteId)).orderBy('savedAt', 'desc').limit(limit).get(),
      ]);
      return [...replaced.docs, ...kept.docs].map((d) => String(d.get('body') ?? ''));
    },

    async rememberReplaced(uid, noteId, body, writtenAt) {
      const col = db.collection(paths.replaced(uid, noteId));
      // Keyed by the text, so the same text twice is one document.
      await col.doc(textHash(body)).set({
        body,
        writtenAt:
          writtenAt === undefined ? FieldValue.serverTimestamp() : Timestamp.fromMillis(writtenAt),
      });
      const old = await col.orderBy('writtenAt', 'desc').offset(REPLACED_KEPT).get();
      await Promise.all(old.docs.map((d) => d.ref.delete()));
    },

    writeMerged(uid, noteId, decide) {
      const ref = db.doc(paths.note(uid, noteId));
      return db.runTransaction(async (tx) => {
        const note = await tx.get(ref);
        if (!note.exists) return false;
        const write = decide({
          body: String(note.get('body') ?? ''),
          deviceId: String(note.get('deviceId') ?? ''),
          updatedBy: String(note.get('updatedBy') ?? ''),
          baseHash: note.get('baseHash'),
        });
        if (!write) return false;
        const update: Record<string, unknown> = {
          body: write.body,
          baseHash: textHash(write.over),
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: note.get('updatedBy') === 'claude' ? 'claude' : 'user',
          deviceId: MERGE_DEVICE,
        };
        if (note.get('titleSource') === 'words') update['title'] = firstWordsTitle(write.body);
        tx.update(ref, update);
        return true;
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
