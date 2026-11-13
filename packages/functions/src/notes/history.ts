// The core of noteHistory: decide whether a note write replaced a
// version worth keeping, and keep it (DESIGN.md, Conflicts).
import { type Author, type KeepReason, keepReason } from '@mossgoblin/schema';

/**
 * A note's fields as a trigger sees them; times in milliseconds. `body`
 * and `title` are the text, opened when sealed (note encryption step 3c,
 * 2026-11-13); `stored` is how they are stored, sealed values as they
 * are, for copies kept on the same note.
 */
export interface NoteState {
  body: string;
  title: string;
  /** body and title as stored; the same as the text when absent (plain). */
  stored?: { body: string; title: string };
  updatedBy: Author;
  /** Which assistant, when updatedBy is claude (#142). */
  agent?: string;
  deviceId: string;
  updatedAt?: number;
  createdAt?: number;
  settledAt?: number;
  titleSource?: string;
  /** `textHash` of the text the writer wrote over; '' when not known. */
  baseHash?: string;
  /** In Trash since (#217); the sweep removes it for good. */
  deletedAt?: number;
}

export interface KeptVersion {
  body: string;
  title: string;
  updatedBy: Author;
  agent?: string;
  deviceId: string;
  updatedAt?: number;
  reason: KeepReason;
}

export interface HistoryStore {
  /** When the newest kept version of this note was kept, if any. */
  lastKept(uid: string, noteId: string): Promise<number | undefined>;
  /**
   * Keeps a version under `versionId` (the trigger event's id), so a
   * redelivered event writes the same document again, not a second one.
   */
  keep(uid: string, noteId: string, versionId: string, version: KeptVersion): Promise<void>;
}

/**
 * Runs on every note write; keeps `before` when the rules say so. The
 * last kept version is looked up only when the interval decides, so
 * most writes (typing on one device) cost no read.
 */
export async function recordHistory(
  store: HistoryStore,
  uid: string,
  noteId: string,
  versionId: string,
  before: NoteState | undefined,
  after: NoteState | undefined,
  now: number,
): Promise<KeepReason | null> {
  if (!before) return null;
  // The sweep removing a note from Trash (#217) keeps nothing: its
  // History goes with it, and a version kept now would outlive it.
  if (!after && before.deletedAt !== undefined) return null;
  // `lastKept = now` rules the interval out: every other reason first.
  let reason = keepReason(before, after, now, now);
  if (!reason && after && after.body !== before.body && before.body.trim()) {
    const since = (await store.lastKept(uid, noteId)) ?? before.createdAt ?? 0;
    reason = keepReason(before, after, since, now);
  }
  if (!reason) return null;
  // The stored form, as it is: a sealed copy opens with the note's own
  // aad, so a kept version is never opened and stored again plain.
  await store.keep(uid, noteId, versionId, {
    body: before.stored?.body ?? before.body,
    title: before.stored?.title ?? before.title,
    updatedBy: before.updatedBy,
    ...(before.updatedBy === 'claude' && before.agent ? { agent: before.agent } : {}),
    deviceId: before.deviceId,
    updatedAt: before.updatedAt,
    reason,
  });
  return reason;
}

/**
 * A write to a sealed note this trigger cannot open (no key here, or a
 * value that does not open): the note is left as stored, and the text
 * the write replaced is kept as stored, so it is not lost while nothing
 * here can merge it. Kept only when the write's own facts say so,
 * without the text: the note was deleted, or another device or author
 * wrote over it; the interval rule needs the text and is skipped.
 * `before` and `after` are as stored (`storedState`).
 */
export async function keepUnopened(
  store: HistoryStore,
  uid: string,
  noteId: string,
  versionId: string,
  before: NoteState | undefined,
  after: NoteState | undefined,
): Promise<KeepReason | null> {
  if (!before) return null;
  if (!after && before.deletedAt !== undefined) return null;
  if (!before.body.trim()) return null;
  if (after && after.body === before.body) return null;
  const reason: KeepReason | null = !after
    ? 'deleted'
    : after.deviceId !== before.deviceId
      ? 'device'
      : after.updatedBy !== before.updatedBy
        ? 'author'
        : null;
  if (!reason) return null;
  await store.keep(uid, noteId, versionId, {
    body: before.body,
    title: before.title,
    updatedBy: before.updatedBy,
    ...(before.updatedBy === 'claude' && before.agent ? { agent: before.agent } : {}),
    deviceId: before.deviceId,
    updatedAt: before.updatedAt,
    reason,
  });
  return reason;
}
