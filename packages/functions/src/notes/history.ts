// The core of noteHistory: decide whether a note write replaced a
// version worth keeping, and keep it (DESIGN.md, Conflicts).
import { type Author, type KeepReason, keepReason } from '@goblin/schema';

/** A note's fields as a trigger sees them; times in milliseconds. */
export interface NoteState {
  body: string;
  title: string;
  updatedBy: Author;
  deviceId: string;
  updatedAt?: number;
  createdAt?: number;
  settledAt?: number;
  titleSource?: string;
}

export interface KeptVersion {
  body: string;
  title: string;
  updatedBy: Author;
  deviceId: string;
  updatedAt?: number;
  reason: KeepReason;
}

export interface HistoryStore {
  /** When the newest kept version of this note was kept, if any. */
  lastKept(uid: string, noteId: string): Promise<number | undefined>;
  keep(uid: string, noteId: string, version: KeptVersion): Promise<void>;
}

/** Runs on every note write; keeps `before` when the rules say so. */
export async function recordHistory(
  store: HistoryStore,
  uid: string,
  noteId: string,
  before: NoteState | undefined,
  after: NoteState | undefined,
  now: number,
): Promise<KeepReason | null> {
  if (!before) return null;
  const since = (await store.lastKept(uid, noteId)) ?? before.createdAt ?? 0;
  const reason = keepReason(before, after, since, now);
  if (!reason) return null;
  await store.keep(uid, noteId, {
    body: before.body,
    title: before.title,
    updatedBy: before.updatedBy,
    deviceId: before.deviceId,
    updatedAt: before.updatedAt,
    reason,
  });
  return reason;
}
