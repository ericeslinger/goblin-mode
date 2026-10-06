// When the noteHistory trigger keeps the version a write replaced
// (DESIGN.md, Conflicts). Pure; times are epoch milliseconds.
import type { Author, KeepReason } from './model';

/** Keep at most one version per this long of edits from one writer. */
export const HISTORY_INTERVAL_MS = 10 * 60 * 1000;

/** A restore writes as its own writer, so the text it replaces is kept. */
export const RESTORE_SUFFIX = '~restore';

export interface VersionFacts {
  body: string;
  deviceId: string;
  updatedBy: Author;
}

/**
 * Whether to keep `before`, the version a write replaced, and why:
 * - `deleted`: the note is gone;
 * - `device`: another device (or a restore) wrote over it;
 * - `author`: Claude wrote over Eric, or Eric over Claude;
 * - `interval`: the same writer, 10 minutes or more since the last kept
 *   version (or since the note was created, before any was kept).
 * An empty `before`, or a write that leaves the body alone (a title
 * update), keeps nothing.
 */
export function keepReason(
  before: VersionFacts,
  after: VersionFacts | undefined,
  lastKept: number,
  now: number,
): KeepReason | null {
  if (!before.body.trim()) return null;
  if (!after) return 'deleted';
  if (after.body === before.body) return null;
  if (after.deviceId !== before.deviceId) return 'device';
  if (after.updatedBy !== before.updatedBy) return 'author';
  return now - lastKept >= HISTORY_INTERVAL_MS ? 'interval' : null;
}
