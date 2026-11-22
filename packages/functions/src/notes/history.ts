// The core of noteHistory: decide whether a note write replaced a
// version worth keeping, and keep it (DESIGN.md, Conflicts).
import { type Author, type KeepReason, type NoteForm, keepReason } from '@mossgoblin/schema';

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
  /** What a model title was made from, keyed (`noteTitleHash`, 2026-11-22). */
  titleHash?: string;
  /**
   * The hash of the text the writer wrote over; '' when not known. Plain
   * (`textHash`) or keyed (`k1.`, a sealed note's, 2026-11-14), as its
   * shape says.
   */
  baseHash?: string;
  /** Whether hashes of this note's text are keyed (`hashForm` of the note as stored). */
  hashForm?: NoteForm;
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
 * What this function instance has seen of when notes' versions were
 * kept (2026-11-22): for each note, a time its `since` (the newest kept
 * version's `savedAt`, or its `createdAt` before any) is at least, so
 * a typing save inside the interval is decided without reading History.
 * Only ever a lower bound, so a decision it makes is the one the read
 * would have made: versions are only added (with `savedAt` the time they
 * were written), and removed only with their note (the Trash sweep).
 * When it cannot rule the interval out, History is read as before. Held
 * in memory, so a cold instance reads once; bounded, oldest out first.
 */
export class KeptTimes {
  private readonly since = new Map<string, { at: number; createdAt?: number }>();

  constructor(private readonly max = 1000) {}

  /** A time this note's `since` is at least, if one is known. */
  floor(uid: string, noteId: string, createdAt: number | undefined): number | undefined {
    const entry = this.since.get(`${uid}/${noteId}`);
    if (!entry) return undefined;
    // Known from `createdAt` alone: only while the note still has it.
    if (entry.createdAt !== undefined && entry.createdAt !== createdAt) return undefined;
    return entry.at;
  }

  /**
   * What a read of History found (`lastKept`), or, finding none, the
   * note's `createdAt` at `now`. A version kept after the read is
   * written after it, so it is newer than `now` (less `KEPT_MARGIN_MS`,
   * for clocks): `since` stays at least the smaller of the two while
   * `createdAt` is unchanged.
   */
  read(
    uid: string,
    noteId: string,
    lastKept: number | undefined,
    createdAt: number | undefined,
    now: number,
  ): void {
    if (lastKept !== undefined) this.set(uid, noteId, { at: lastKept });
    else if (createdAt !== undefined) {
      this.set(uid, noteId, { at: Math.min(createdAt, now - KEPT_MARGIN_MS), createdAt });
    }
  }

  /**
   * A version just kept, at `now` or later (its `savedAt` is the server's
   * time of the write, after `now`); `KEPT_MARGIN_MS` earlier, for clocks.
   */
  kept(uid: string, noteId: string, now: number): void {
    const at = now - KEPT_MARGIN_MS;
    const had = this.floor(uid, noteId, undefined);
    if (had === undefined || had < at) this.set(uid, noteId, { at });
  }

  private set(uid: string, noteId: string, entry: { at: number; createdAt?: number }): void {
    const key = `${uid}/${noteId}`;
    this.since.delete(key);
    this.since.set(key, entry);
    if (this.since.size > this.max) this.since.delete(this.since.keys().next().value!);
  }
}

/** How much earlier than the trigger's clock a kept version is taken as kept. */
export const KEPT_MARGIN_MS = 1000;

/**
 * Runs on every note write; keeps `before` when the rules say so. Every
 * reason but the interval is decided from the write itself. A write
 * that changes the body otherwise needs `since`, the newest kept
 * version's time: until 2026-11-22 every such write read it, so each
 * typing save cost a read of History. Now `kept` (one per instance,
 * triggers.ts), a lower bound on `since`, decides it first when it can:
 * a typing save on one device inside the interval reads nothing, and
 * History keeps exactly what it kept before.
 */
export async function recordHistory(
  store: HistoryStore,
  uid: string,
  noteId: string,
  versionId: string,
  before: NoteState | undefined,
  after: NoteState | undefined,
  now: number,
  kept?: KeptTimes,
): Promise<KeepReason | null> {
  if (!before) return null;
  // The sweep removing a note from Trash (#217) keeps nothing: its
  // History goes with it, and a version kept now would outlive it.
  if (!after && before.deletedAt !== undefined) return null;
  // `lastKept = now` rules the interval out: every other reason first.
  let reason = keepReason(before, after, now, now);
  if (!reason && after && after.body !== before.body && before.body.trim()) {
    // Ruled out by what is known here, the read would rule it out too.
    const floor = kept?.floor(uid, noteId, before.createdAt);
    if (floor !== undefined && keepReason(before, after, floor, now) === null) return null;
    const lastKept = await store.lastKept(uid, noteId);
    kept?.read(uid, noteId, lastKept, before.createdAt, now);
    reason = keepReason(before, after, lastKept ?? before.createdAt ?? 0, now);
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
  kept?.kept(uid, noteId, now);
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
  now?: number,
  kept?: KeptTimes,
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
  if (now !== undefined) kept?.kept(uid, noteId, now);
  return reason;
}
