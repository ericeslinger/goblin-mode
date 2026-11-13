// What noteHistory and noteTitle do with one note write, over a
// Firestore and a codec, so specs run it without the trigger (note
// encryption step 3c, 2026-11-13). A sealed note's text is opened with
// the event's one codec and written back in its own form; a note that
// cannot be opened here is left as stored, and the log says so once.
// Neither throws for a sealed note, and onDocumentWritten retries only
// with `retry: true`, which neither trigger sets, so a missing key
// never loops.
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { type NoteCodec, SealedNoteError, logLeftSealed } from '../mcp/note-text';
import { firestoreNotesStore, openState, storedState } from './firestore-store';
import { type NoteState, keepUnopened, recordHistory } from './history';
import { type MergeOutcome, mergeConflict, rememberReplaced } from './merge';
import { type TitleOutcome, type Titler, titleNote } from './title';

export interface Log {
  debug(message: string, fields?: unknown): void;
  info(message: string, fields?: unknown): void;
  warn(message: string, fields?: unknown): void;
}

export interface HistoryOutcome {
  kept: string | null;
  merged: MergeOutcome | 'none';
  /** Sealed, and it did not open here: left as stored. */
  sealed?: true;
}

/**
 * noteHistory: keeps the version a write replaced when the rules say
 * so, remembers the text it replaced, and merges a write over text its
 * writer had not seen. For a sealed note that cannot be opened here, the
 * note is left as stored and what the write replaced is kept in History
 * as stored when the write's own facts say so (keepUnopened), so it is
 * not lost while nothing here can merge it.
 */
export async function historyOnWrite(
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  noteId: string,
  eventId: string,
  beforeSnap: DocumentSnapshot | undefined,
  afterSnap: DocumentSnapshot | undefined,
  now: number,
  log: Log,
): Promise<HistoryOutcome> {
  const store = firestoreNotesStore(db, codec);
  const stored = [storedState(beforeSnap), storedState(afterSnap)] as const;
  // The same stored body before and after: nothing to keep, remember or
  // merge (each needs the body changed), so nothing is opened either.
  if (stored[0] && stored[1] && stored[0].body === stored[1].body) {
    return { kept: null, merged: 'none' };
  }
  // The sweep removing a note from Trash (#217): nothing is kept.
  if (!stored[1] && stored[0]?.deletedAt !== undefined) return { kept: null, merged: 'none' };
  let before: NoteState | undefined;
  let after: NoteState | undefined;
  try {
    before = await openState(codec, noteId, stored[0]);
    after = await openState(codec, noteId, stored[1]);
  } catch (err) {
    if (!(err instanceof SealedNoteError)) throw err;
    const kept = await keepUnopened(store, uid, noteId, eventId, ...stored);
    if (kept) log.debug('noteHistory kept a version as stored', { noteId, reason: kept });
    logLeftSealed(log, 'noteHistory', err);
    return { kept, merged: 'none', sealed: true };
  }
  const kept = await recordHistory(store, uid, noteId, eventId, before, after, now);
  if (kept) log.debug('noteHistory kept a version', { noteId, reason: kept });
  // The text this write replaced, for a later merge to start from.
  await rememberReplaced(store, uid, noteId, before, after, (message, err) =>
    log.warn(message, err),
  );
  // A write over text its writer had not seen: merge the two (#37).
  try {
    const merged = await mergeConflict(store, uid, noteId, before, after);
    if (merged !== 'clean') log.info('noteHistory merge', { noteId, merged });
    return { kept, merged };
  } catch (err) {
    // Its kept texts, or the note as it now stands, did not open.
    if (!(err instanceof SealedNoteError)) throw err;
    logLeftSealed(log, 'noteHistory merge', err);
    return { kept, merged: 'none', sealed: true };
  }
}

/**
 * noteTitle: a model title when a settle asks for one. A sealed body is
 * opened for the model and the title written sealed; a note that cannot
 * be opened here gets no title and is not written ('sealed').
 */
export async function titleOnWrite(
  db: Firestore,
  codec: NoteCodec,
  titler: Titler | null,
  uid: string,
  noteId: string,
  beforeSnap: DocumentSnapshot | undefined,
  afterSnap: DocumentSnapshot | undefined,
  log: Log,
): Promise<TitleOutcome | 'sealed'> {
  const was = storedState(beforeSnap);
  const now = storedState(afterSnap);
  // Opened only when a settle could ask for a title: most writes do not.
  if (!now || now.settledAt === undefined || was?.settledAt === now.settledAt) return 'skipped';
  let before: NoteState | undefined;
  let after: NoteState | undefined;
  try {
    before = await openState(codec, noteId, was);
    after = await openState(codec, noteId, now);
  } catch (err) {
    if (!(err instanceof SealedNoteError)) throw err;
    logLeftSealed(log, 'noteTitle', err);
    return 'sealed';
  }
  return titleNote(firestoreNotesStore(db, codec), titler, uid, noteId, before, after, (m, e) =>
    log.warn(m, e),
  );
}
