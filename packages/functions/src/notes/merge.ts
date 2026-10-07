// The server half of safe co-editing (#37). A write records the text it
// was written over (`baseHash`). When that is not the text it replaced,
// the writer had not seen the newer text: an offline device coming back,
// or a save crossing Claude's line edit. Then both are merged, from a
// text they share, which history kept when the newer text replaced it.
import { merge3, textHash } from '@mossgoblin/schema';
import type { NoteState } from './history';

/** The deviceId of a merge, so history keeps the write it merged. */
export const MERGE_DEVICE = 'merge';
/** How many kept versions to search for the shared text. */
export const BASE_SEARCH = 20;
/**
 * How many texts writes replaced a note keeps, newest first, to find a
 * merge's shared text: History keeps a version only now and then, and
 * the text a stale write was built on is usually a recent one it skipped
 * (2026-10-07, Eric's note kept both copies of two lines). One document
 * each, so saves arriving together never contend.
 */
export const REPLACED_KEPT = 20;
/** How long a replaced text is kept at most (a Firestore TTL policy). */
export const REPLACED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Longer texts are not kept: one must fit in a document (1 MiB). */
export const REPLACED_CHARS = 300_000;

/** The note as it stands when a merge is written. */
export interface CurrentNote {
  body: string;
  deviceId: string;
  updatedBy: string;
  baseHash?: string;
}

export interface MergeStore {
  /**
   * Texts to find a shared one among: those writes recently replaced,
   * then the newest `limit` kept versions; each newest first.
   */
  keptBodies(uid: string, noteId: string, limit: number): Promise<string[]>;
  /**
   * Keeps a text a write replaced, as of when it was written (ms),
   * until a TTL policy removes it (`REPLACED_TTL_MS`).
   */
  rememberReplaced(uid: string, noteId: string, body: string, writtenAt?: number): Promise<void>;
  /**
   * In a transaction: reads the note, and writes what `decide` returns
   * for it (a body and the text it was written over), or nothing.
   */
  writeMerged(
    uid: string,
    noteId: string,
    decide: (current: CurrentNote) => { body: string; over: string } | undefined,
  ): Promise<boolean>;
}

export type MergeOutcome = 'merged' | 'kept-both' | 'clean' | 'moved-on';

/**
 * Remembers the text a write replaced, so a later merge can start from
 * it. Never throws: a merge must run whether or not this worked.
 */
export async function rememberReplaced(
  store: MergeStore,
  uid: string,
  noteId: string,
  before: NoteState | undefined,
  after: NoteState | undefined,
  warn: (message: string, err: unknown) => void = () => undefined,
): Promise<boolean> {
  if (!before || !after || before.body === after.body || !before.body.trim()) return false;
  if (before.body.length > REPLACED_CHARS) return false;
  try {
    await store.rememberReplaced(uid, noteId, before.body, before.updatedAt);
    return true;
  } catch (err) {
    warn('rememberReplaced failed', err);
    return false;
  }
}

/**
 * Whether `current` was written knowing `text`: the same writer's later
 * save, a write made straight over it, or Claude's (its tools edit the
 * current text in a transaction).
 */
function builtOn(current: CurrentNote, text: string, writer: string): boolean {
  return (
    current.deviceId === writer ||
    current.baseHash === textHash(text) ||
    current.updatedBy === 'claude'
  );
}

export async function mergeConflict(
  store: MergeStore,
  uid: string,
  noteId: string,
  before: NoteState | undefined,
  after: NoteState | undefined,
): Promise<MergeOutcome> {
  if (!before || !after || !after.baseHash || after.body === before.body) return 'clean';
  if (after.baseHash === textHash(before.body)) return 'clean';
  const kept = await store.keptBodies(uid, noteId, BASE_SEARCH);
  const at = (hash: string | undefined) =>
    hash ? kept.findIndex((b) => textHash(b) === hash) : -1;
  // The two writes may start from different texts (two devices, one of
  // them saving twice): the older one is shared by both, so merge from
  // it; a newer one only one side has seen would read as a deletion.
  const index = Math.max(at(after.baseHash), at(before.baseHash));
  // No shared text kept: merge as if neither side had any in common, so
  // every line of both is kept (an edited line may show twice, a deleted
  // one come back), rather than one side's text being lost.
  const base = index < 0 ? '' : kept[index];
  const merged = merge3(base, after.body, before.body);
  if (merged === after.body) return 'clean';
  let outcome: MergeOutcome = 'moved-on';
  await store.writeMerged(uid, noteId, (current) => {
    let body: string;
    if (current.body === after.body) body = merged;
    // Saved again since, building on this write: carry the merge onto
    // that, or it would be lost to a trigger that sees nothing to merge.
    else if (builtOn(current, after.body, after.deviceId))
      body = merge3(after.body, current.body, merged);
    // A third writer that had not seen it: merge all three from the text
    // they share.
    else body = merge3(base, current.body, merged);
    if (body === current.body) {
      outcome = 'clean';
      return undefined;
    }
    outcome = index < 0 ? 'kept-both' : 'merged';
    return { body, over: current.body };
  });
  return outcome;
}
