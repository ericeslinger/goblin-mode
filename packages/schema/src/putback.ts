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
 * The tool a reroute records itself as (#235): after a put back of a
 * filing, Eric filing its notes under the project he picks.
 */
export const REROUTE_TOOL = 'reroute';

/**
 * The activity id of the reroute that follows put back `putBackRunId`.
 * Derived like a put back's, so a second tap finds the first.
 */
export function rerouteId(putBackRunId: string): string {
  return `reroute-${putBackRunId}`;
}

/**
 * Which notes "File it under…" files once run `run` is put back (#235),
 * none when the run was no filing. Read from the record as the put back
 * plan reads it: a merge lists its merged note first, then the
 * originals, which the put back restores; a `refile` that filed a
 * project under another keeps `parent` among its `before`; a
 * `link_notes` names the note it linked first, then its targets, one of
 * them a project (`isProject`, from the notes as they are); a reroute
 * lists the notes it filed. A plain text edit, tagging or a finished
 * queue item files nothing.
 */
export function rerouteNotes(
  run: { tool: string; summary: string; notes: readonly { id: string; before?: unknown }[] },
  isProject: (id: string) => boolean,
): string[] {
  const [first, ...rest] = run.notes;
  if (!first) return [];
  switch (run.tool) {
    case 'merge_notes':
      return rest.map((n) => n.id);
    case 'refile': {
      const before = first.before;
      const parent = !!before && typeof before === 'object' && 'parent' in before;
      return parent && /\bfiled under\b/.test(run.summary) ? [first.id] : [];
    }
    case 'link_notes':
      return rest.some((n) => isProject(n.id)) ? [first.id] : [];
    case REROUTE_TOOL:
      return run.notes.map((n) => n.id);
    default:
      return [];
  }
}

/**
 * Runs that change fields History does not keep, only text: filing
 * (types, names, tags, stages), a sent note marked done, and a reroute
 * (#235), which keeps a project's `parent` or a note's `links` with the
 * hash of its text before. Their
 * records keep the values they replaced (`before` on each note, #206,
 * 2026-11-09); a record from before that cannot be put back.
 */
const KEEPS_BEFORE = new Set(['refile', 'finish_queued', 'reroute']);

/**
 * Whether an `update_note` record's summary says the run changed the
 * note's text, as tools.ts words it ("Changed a note's text and tags").
 * Put back's plan and the diff view both read it here, so the wording
 * has one home (review on #243).
 */
export function summarySaysText(summary: string): boolean {
  return /\btext\b/.test(summary);
}

/** Whether a run can be offered Put back: it touched notes, in a way it can undo. */
export function canPutBack(run: { tool: string; notes: readonly { before?: unknown }[] }): boolean {
  if (run.notes.length === 0) return false;
  return !KEEPS_BEFORE.has(run.tool) || run.notes.every((n) => n.before !== undefined);
}
