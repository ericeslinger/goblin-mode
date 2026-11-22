import { firstWordsTitle, hashForm, isSealed, paths } from '@mossgoblin/schema';
import {
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import {
  type NoteCodec,
  NoteSnap,
  SealedNoteError,
  formsOf,
  sealFields,
  storedText,
} from '../mcp/note-text';
import type { HistoryStore, NoteState } from './history';
import { MERGE_DEVICE, type MergeStore, REPLACED_KEPT, REPLACED_TTL_MS } from './merge';
import type { TitleStore } from './title';

const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined);

/**
 * A trigger's before or after snapshot as NoteState, its body and title
 * as stored (sealed values as they are); undefined if absent.
 */
export function storedState(snap: DocumentSnapshot | undefined): NoteState | undefined {
  if (!snap?.exists) return undefined;
  const d = snap.data() ?? {};
  return {
    // As stored: openState opens them, keepUnopened keeps them as they are.
    body: storedText(d, 'body'),
    title: storedText(d, 'title'),
    titleSource: typeof d['titleSource'] === 'string' ? d['titleSource'] : undefined,
    ...(typeof d['titleHash'] === 'string' ? { titleHash: d['titleHash'] } : {}),
    updatedBy: d['updatedBy'] === 'claude' ? 'claude' : 'user',
    ...(typeof d['agent'] === 'string' ? { agent: d['agent'] } : {}),
    deviceId: String(d['deviceId'] ?? ''),
    updatedAt: millis(d['updatedAt']),
    createdAt: millis(d['createdAt']),
    settledAt: millis(d['settledAt']),
    baseHash: typeof d['baseHash'] === 'string' ? d['baseHash'] : undefined,
    hashForm: hashForm(formsOf(d)),
    ...(millis(d['deletedAt']) !== undefined ? { deletedAt: millis(d['deletedAt']) } : {}),
  };
}

/**
 * `state` (as stored, of note `noteId`) with its body and title opened,
 * and how they are stored in `stored`. Plain text passes through, asking
 * for no key; throws SealedNoteError when a sealed value does not open.
 */
export async function openState(
  codec: NoteCodec,
  noteId: string,
  state: NoteState | undefined,
): Promise<NoteState | undefined> {
  if (!state) return undefined;
  return {
    ...state,
    body: await codec.open(noteId, 'body', state.body),
    title: await codec.open(noteId, 'title', state.title),
    stored: { body: state.body, title: state.title },
  };
}

/**
 * History and title writes over Firestore, as the admin SDK. `codec`
 * (one per trigger event) opens the texts a merge reads, and seals what
 * a merge or a title writes in the note's own form.
 */
export function firestoreNotesStore(
  db: Firestore,
  codec: NoteCodec,
): HistoryStore & TitleStore & MergeStore {
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
      // Every field the NoteVersion schema names, nothing more. The body
      // and title are the note's as stored (recordHistory, keepUnopened),
      // sealed as they are kept (`keptForm`, 2026-11-15).
      const [body, title] = await Promise.all([
        keptForm(codec, noteId, 'body', v.body),
        keptForm(codec, noteId, 'title', v.title),
      ]);
      await db.doc(`${paths.history(uid, noteId)}/${versionId}`).set({
        body,
        title,
        updatedBy: v.updatedBy,
        ...(v.agent ? { agent: v.agent } : {}),
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
      // Copies of this note's body, sealed or plain as it was: each opens
      // with the note's own aad. One that does not open (a key the
      // gardener no longer has) is no shared text; with no key at all
      // the merge stops, and the note stays as stored.
      const out: string[] = [];
      for (const d of [...replaced.docs, ...kept.docs]) {
        try {
          out.push(await codec.open(noteId, 'body', storedText(d.data(), 'body')));
        } catch (err) {
          if (!(err instanceof SealedNoteError) || err.reason === 'no-key') throw err;
        }
      }
      return out;
    },

    async rememberReplaced(uid, noteId, body, writtenAt, stored = body) {
      const col = db.collection(paths.replaced(uid, noteId));
      // Keyed by the text, so the same text twice is one document. Its
      // id is the text's keyed hash, as baseHash holds it (2026-11-14,
      // always keyed since 2026-11-15), and with no key it throws,
      // keeping nothing rather than a plain id.
      await col.doc(await codec.hashText(noteId, body)).set({
        // Sealed as it is kept (2026-11-15).
        body: await keptForm(codec, noteId, 'body', stored),
        writtenAt:
          writtenAt === undefined ? FieldValue.serverTimestamp() : Timestamp.fromMillis(writtenAt),
        // A TTL policy (firestore.indexes.json) removes it after this,
        // so a deleted note's texts do not stay forever.
        expireAt: Timestamp.fromMillis(Date.now() + REPLACED_TTL_MS),
      });
      // No trim by count: saves arriving together each trimmed by the
      // count they saw, and together deleted the newest texts too
      // (2026-10-07). The TTL removes them; merges read the newest.
    },

    writeMerged(uid, noteId, decide) {
      const ref = db.doc(paths.note(uid, noteId));
      return db.runTransaction(async (tx) => {
        const note = await NoteSnap.open(codec, await tx.get(ref));
        if (!note.exists) return false;
        // Throws SealedNoteError when any of its text did not open, so
        // nothing is written over text this trigger has not seen.
        const current = note.data()!;
        const write = decide({
          body: String(current['body'] ?? ''),
          deviceId: String(current['deviceId'] ?? ''),
          updatedBy: String(current['updatedBy'] ?? ''),
          baseHash: current['baseHash'] as string | undefined,
        });
        if (!write) return false;
        const update: Record<string, unknown> = {
          body: write.body,
          // Keyed, as every hash written is (2026-11-15).
          baseHash: await codec.hashText(noteId, write.over),
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: current['updatedBy'] === 'claude' ? 'claude' : 'user',
          deviceId: MERGE_DEVICE,
        };
        if (current['titleSource'] === 'words') update['title'] = firstWordsTitle(write.body);
        // Sealed under the note's own id, as every write is.
        tx.update(ref, await sealFields(codec, noteId, update));
        return true;
      });
    },

    titleHash(noteId, title, text) {
      return codec.titleHash(noteId, title, text);
    },

    setTitle(uid, noteId, forSettledAt, title, titleHash) {
      const ref = db.doc(paths.note(uid, noteId));
      return db.runTransaction(async (tx) => {
        const note = await tx.get(ref);
        if (!note.exists || note.get('titleSource') === 'user') return false;
        if (millis(note.get('settledAt')) !== forSettledAt) return false;
        // Only the title and what it was made from: updatedAt, updatedBy
        // and deviceId stay the writer's. Sealed, as every write is
        // (2026-11-15); the hash is keyed (2026-11-22). Without one an
        // old hash may stay: it covers its own title, so it matches only
        // a title the same as this one, of the same text.
        const update = { title, titleSource: 'llm', ...(titleHash ? { titleHash } : {}) };
        tx.update(ref, await sealFields(codec, noteId, update));
        return true;
      });
    },
  };
}

/**
 * A copy of note `noteId`'s `field` as History or a replaced text keeps
 * it (2026-11-15): a plain value sealed under the note's own id, so it
 * opens as the note's does; a sealed value as it is. With no key it is
 * kept as stored: History keeps a text a write replaced so it is never
 * lost, and that text was stored plain already.
 */
async function keptForm(
  codec: NoteCodec,
  noteId: string,
  field: 'body' | 'title',
  value: string,
): Promise<string> {
  if (isSealed(value)) return value;
  try {
    return await codec.seal(noteId, field, value);
  } catch (err) {
    if (err instanceof SealedNoteError && err.reason === 'no-key') return value;
    throw err;
  }
}
