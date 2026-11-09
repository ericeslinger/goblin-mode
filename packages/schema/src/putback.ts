// Put back (#154 step 1): undoing one run listed in What assistants
// changed. Shared by the app, which offers it, and the revertRun
// callable, which does it (DESIGN.md, Trust, step 1).

/** The tool a put back records itself as, in What assistants changed. */
export const PUT_BACK_TOOL = 'put_back';

const PREFIX = 'putback-';

/**
 * The activity id of the put back of run `runId`. Derived, so a second
 * put back of the same run finds the first and stops, and the app can
 * tell a run already put back from the list alone.
 */
export function putBackId(runId: string): string {
  return `${PREFIX}${runId}`;
}

/**
 * The run a put back started from, and how many put backs deep this
 * one is: 0 for an assistant's own run, 1 for its put back, 2 for the
 * put back of that, and so on.
 */
export function putBackDepth(runId: string): { base: string; depth: number } {
  let base = runId;
  let depth = 0;
  while (base.startsWith(PREFIX)) {
    base = base.slice(PREFIX.length);
    depth++;
  }
  return { base, depth };
}

/**
 * Runs History cannot undo: filing (types, names, tags, stages) and a
 * sent note marked done change fields History does not keep, only text.
 */
const NOT_PUT_BACK = new Set(['refile', 'finish_queued']);

/** Whether a run can be offered Put back: it touched notes, in a way History can undo. */
export function canPutBack(run: { tool: string; notes: readonly unknown[] }): boolean {
  return run.notes.length > 0 && !NOT_PUT_BACK.has(run.tool);
}
