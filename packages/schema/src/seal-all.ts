// Seal everything now (note encryption, the migration, Eric,
// 2026-11-15; DESIGN.md, "Note encryption", The migration). The
// `sealEverything` callable seals, in one pass, what the gardener's
// switch left plain: notes, their History versions, suggestions, runs,
// and the names in What assistants changed. These are the shapes of
// what it is asked and what it answers, shared by the app and the
// functions. Nothing here is stored: the pass keeps no progress
// document, and running it again is how it resumes.

/** The kinds of work, in the order a pass does them. */
export const SEAL_KINDS = ['notes', 'suggestions', 'runs', 'activity'] as const;
export type SealKind = (typeof SEAL_KINDS)[number];

/** What a report counts: a note's History versions are counted apart. */
export const SEAL_COUNTED = ['notes', 'versions', 'suggestions', 'runs', 'activity'] as const;
export type SealCounted = (typeof SEAL_COUNTED)[number];

/**
 * Why something was left as stored:
 * - `cannot-open`: its sealed text does not open with the gardener's key;
 * - `busy`: a recipe whose import was asked for minutes ago, which its
 *   own function is about to read, so the next pass takes it;
 * - `not-verified`: what was sealed did not open back to the same text,
 *   so nothing was written (never expected: a fault to report);
 * - `id-kept`: an item run sealed, but left under its old id: a newer
 *   run for the same item holds the new one, or it has not finished;
 * - `too-large`: sealed, it would pass Firestore's limit for one
 *   document (sealed text is about a third longer);
 * - `contended`: it kept being changed while the pass tried to write it;
 * - `failed`: anything else went wrong with it; `failures` says the
 *   error's name, nothing more (review on #277, 2026-11-15).
 */
export const SEAL_LEFT_REASONS = [
  'cannot-open',
  'busy',
  'not-verified',
  'id-kept',
  'too-large',
  'contended',
  'failed',
] as const;
export type SealLeftReason = (typeof SEAL_LEFT_REASONS)[number];

/** Where a pass stopped, to start the next one from. */
export interface SealCursor {
  kind: SealKind;
  /** The last document id done in that kind, in document id order. */
  after?: string;
}

/** What the app asks. */
export interface SealRequest {
  /** Count only, write nothing. */
  dryRun: boolean;
  cursor?: SealCursor;
}

export type SealCounts = Record<SealCounted, number>;

/** What one pass did, or in a dry run would do. */
export interface SealReport {
  dryRun: boolean;
  /** Sealed (notes, versions, suggestions, runs) or relabelled (activity). */
  sealed: SealCounts;
  /** Left as stored, by what and why. */
  left: Record<SealCounted, Partial<Record<SealLeftReason, number>>>;
  /** Item runs moved to an id that holds no plain hash of their text. */
  runsMoved: number;
  /**
   * Plain hashes of a text no longer kept anywhere (a write's base, or
   * what a change replaced): replaced by a keyed hash that matches no
   * text, so nothing guessable is left and nothing behaves differently.
   */
  hashesUnkept: number;
  /** Replaced texts still plain, left to expire (Eric, 2026-11-15). */
  replaced: { plain: number; lastExpiresAt?: string };
  /** How many documents `failed`, by the error's name only: never a message or any text. */
  failures: Record<string, number>;
}

/** What the callable answers: a report, and a cursor when it ran out of time. */
export interface SealPass {
  done: boolean;
  cursor?: SealCursor;
  report: SealReport;
}

/** An empty report. */
export function emptySealReport(dryRun: boolean): SealReport {
  const zero = () => Object.fromEntries(SEAL_COUNTED.map((k) => [k, 0])) as SealCounts;
  return {
    dryRun,
    sealed: zero(),
    left: Object.fromEntries(SEAL_COUNTED.map((k) => [k, {}])) as SealReport['left'],
    runsMoved: 0,
    hashesUnkept: 0,
    replaced: { plain: 0 },
    failures: {},
  };
}

/** Two reports of passes over different documents, as one. */
export function addSealReports(a: SealReport, b: SealReport): SealReport {
  const out = emptySealReport(a.dryRun);
  for (const k of SEAL_COUNTED) {
    out.sealed[k] = a.sealed[k] + b.sealed[k];
    for (const r of SEAL_LEFT_REASONS) {
      const n = (a.left[k][r] ?? 0) + (b.left[k][r] ?? 0);
      if (n) out.left[k][r] = n;
    }
  }
  out.runsMoved = a.runsMoved + b.runsMoved;
  out.hashesUnkept = a.hashesUnkept + b.hashesUnkept;
  out.replaced.plain = a.replaced.plain + b.replaced.plain;
  for (const f of [a.failures, b.failures]) {
    for (const [name, n] of Object.entries(f ?? {}))
      out.failures[name] = (out.failures[name] ?? 0) + n;
  }
  const last = [a.replaced.lastExpiresAt, b.replaced.lastExpiresAt].filter((x): x is string => !!x);
  if (last.length) out.replaced.lastExpiresAt = last.sort().at(-1);
  return out;
}

/** How many things were left, over every kind and reason. */
export function sealLeftTotal(report: SealReport): number {
  return SEAL_COUNTED.reduce(
    (n, k) => n + SEAL_LEFT_REASONS.reduce((m, r) => m + (report.left[k][r] ?? 0), 0),
    0,
  );
}
