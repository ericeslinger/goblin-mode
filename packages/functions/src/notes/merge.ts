// The server half of safe co-editing (#37). A write records the text it
// was written over (`baseHash`). When that is not the text it replaced,
// the writer had not seen the newer text: an offline device coming back,
// or a save crossing Claude's line edit. Then both are merged, from the
// text they share, which history kept when the newer text replaced it.
import { merge3, textHash } from '@mossgoblin/schema';
import type { NoteState } from './history';

/** The deviceId of a merge, so history keeps the write it merged. */
export const MERGE_DEVICE = 'merge';
/** How many kept versions to search for the shared text. */
export const BASE_SEARCH = 20;

export interface MergeStore {
  /** The bodies of the newest kept versions, newest first. */
  keptBodies(uid: string, noteId: string, limit: number): Promise<string[]>;
  /** Writes `merged` only while the note's body is still `over`. */
  writeMerged(uid: string, noteId: string, over: string, merged: string): Promise<boolean>;
}

export type MergeOutcome = 'merged' | 'clean' | 'no-base' | 'moved-on';

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
  const base = kept.find((b) => textHash(b) === after.baseHash);
  // Without the shared text a merge would guess; history has `before`.
  if (base === undefined) return 'no-base';
  const merged = merge3(base, after.body, before.body);
  if (merged === after.body) return 'clean';
  return (await store.writeMerged(uid, noteId, after.body, merged)) ? 'merged' : 'moved-on';
}
