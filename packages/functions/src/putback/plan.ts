// Put back (#154 step 1), the pure half: given the run to undo, the run
// it started from, and the notes as they stand now, which writes put
// them back (DESIGN.md, Trust, step 1). The text comes back verbatim
// from what the run wrote over; nothing here composes text.
import { type FieldBefore, firstWordsTitle, textHash } from '@mossgoblin/schema';

/**
 * How far before its activity record a run's own note write can be
 * stamped: a tool stamps the note and its record from separate clock
 * reads inside one function call.
 */
export const RUN_SLACK_MS = 5_000;

/** An activity record, as the plan needs it; times in milliseconds. */
export interface RunFacts {
  id: string;
  at: number;
  tool: string;
  summary: string;
  /** The deviceId the run's note writes carry. */
  device: string;
  /**
   * `made`: the run made that note (#211); `before`: the fields it
   * changed, with their values before (#206). Absent on older records.
   */
  notes: { id: string; title: string; made?: boolean; before?: Record<string, FieldBefore> }[];
}

/** A note as it stands now. */
export interface NoteFacts {
  id: string;
  body: string;
  title: string;
  titleSource?: string;
  archived: boolean;
  mergedInto?: string;
  updatedAt?: number;
  deviceId: string;
  /** `textHash` of the text its last body write replaced. */
  baseHash?: string;
  /** Its stored fields, for putting back a run's `before` (#206). */
  fields?: Record<string, unknown>;
}

/** What the original run did to one note, read from its record and tool. */
export type Did =
  | { kind: 'created' }
  | { kind: 'merged' }
  | { kind: 'original'; into: string }
  | { kind: 'edited'; flip?: 'archived' | 'restored'; text: boolean }
  /**
   * Filing or a finished queue item (#206): fields its record kept the
   * values before of, and the text too where the record keeps the hash
   * of the text it rewrote (`before.body`, filing as a project).
   */
  | { kind: 'fields'; text: boolean };

/**
 * What run `base` (an assistant's own run) did to each note it lists.
 * A merge lists the merged note first, then its originals; the record
 * marks a note the run made (`made`, #211, 2026-11-09), never a note's
 * own times, which a note Eric made a moment before shares; archive_note
 * and update_note say in their summary whether they archived or
 * restored. Everything else changed text, if it wrote the note at all
 * (a link's targets it only names), which the plan checks against the
 * note. A record from before `made` reads a note it made as edited,
 * with no text before it, so the plan leaves it alone. Filing and
 * `finish_queued` change fields, which their records keep (`before`,
 * #206, 2026-11-09); a record from before that names its notes only.
 */
export function didOf(base: RunFacts): Map<string, Did> {
  const out = new Map<string, Did>();
  base.notes.forEach((t, i) => {
    if (base.tool === 'merge_notes') {
      out.set(t.id, i === 0 ? { kind: 'merged' } : { kind: 'original', into: base.notes[0].id });
      return;
    }
    if (base.tool === 'refile' || base.tool === 'finish_queued') {
      if (t.before)
        out.set(t.id, {
          kind: 'fields',
          text: typeof t.before['body'] === 'string',
        });
      return;
    }
    if (t.made === true) {
      out.set(t.id, { kind: 'created' });
      return;
    }
    const flip = /\bArchived a note\b/.test(base.summary)
      ? 'archived'
      : /\bRestored a note\b/.test(base.summary)
        ? 'restored'
        : undefined;
    if (base.tool === 'archive_note') {
      out.set(t.id, { kind: 'edited', ...(flip ? { flip } : {}), text: false });
      return;
    }
    if (base.tool === 'update_note') {
      out.set(t.id, {
        kind: 'edited',
        ...(flip ? { flip } : {}),
        text: /\btext\b/.test(base.summary),
      });
      return;
    }
    out.set(t.id, { kind: 'edited', text: true });
  });
  return out;
}

/** One note's write in a put back; absent fields stay as they are. */
export interface NoteWrite {
  id: string;
  /** Title as it reads after the write, for the record. */
  title: string;
  archived?: boolean;
  /** A merge's original: the merged note's id again, or null to remove it. */
  mergedInto?: string | null;
  /** The text the run wrote over, verbatim, and its first-words title. */
  body?: string;
  newTitle?: string;
  /** Fields to set back (#206); null deletes the field. */
  fields?: Record<string, FieldBefore>;
  /** What those fields hold now, null where absent: the put back's own `before`. */
  before?: Record<string, FieldBefore>;
}

export type Skip = { id: string; title: string; why: 'gone' | 'changed' | 'unkept' };

export interface Plan {
  writes: NoteWrite[];
  skipped: Skip[];
}

/**
 * The writes that put back run `run`, `depth` put backs deep from `base`
 * (0: `run` is `base`). An even depth undoes what `base` did; an odd one
 * (putting back a put back) does it again. Only notes `run` itself last
 * wrote are written: one written since is left alone (Eric's edit after
 * the run stays; History has the rest), and one it never wrote (a
 * link's target) needs nothing. Text comes from `textBefore`, the text
 * the run's write replaced, found by the write's `baseHash` (for filing,
 * by the hash its record kept, `before.body`). Fields come
 * from the run's own record (`before`, #206): at an even depth the
 * values `base` replaced, at an odd one the values its put back
 * replaced, which are what `base` wrote, so both directions are one
 * path. `finish_queued` leaves who last wrote a note as it was, so its
 * notes are the run's while the queue mark is as it left it: done, or
 * queued again after a put back.
 */
export function planPutBack(args: {
  run: RunFacts;
  base: RunFacts;
  depth: number;
  notes: Map<string, NoteFacts>;
  textBefore: Map<string, string>;
}): Plan {
  const { run, base, depth, notes, textBefore } = args;
  const did = didOf(base);
  const redo = depth % 2 === 1;
  const writes: NoteWrite[] = [];
  const skipped: Skip[] = [];
  // finish_queued writes no stamp; its notes are told by the queue mark.
  const unstamped = run.tool === 'finish_queued';
  const queue = base.tool === 'finish_queued' ? (redo ? 'queued' : 'done') : undefined;
  for (const t of run.notes) {
    const note = notes.get(t.id);
    const what = did.get(t.id);
    if (!note) {
      skipped.push({ id: t.id, title: t.title, why: 'gone' });
      continue;
    }
    if (!what) continue;
    const at = note.updatedAt ?? 0;
    if (at > run.at || (queue && note.fields?.['sendState'] !== queue)) {
      skipped.push({ id: t.id, title: note.title || t.title, why: 'changed' });
      continue;
    }
    if (!unstamped && (note.deviceId !== run.device || at < run.at - RUN_SLACK_MS)) continue;
    const write: NoteWrite = { id: t.id, title: note.title };
    let archived: boolean | undefined;
    switch (what.kind) {
      case 'created':
      case 'merged':
        archived = !redo;
        break;
      case 'original':
        archived = redo;
        write.mergedInto = redo ? what.into : null;
        break;
      case 'edited':
        if (what.flip) archived = (what.flip === 'archived') === redo;
        break;
    }
    if (archived !== undefined && archived !== note.archived) write.archived = archived;
    if (write.mergedInto !== undefined && (write.mergedInto ?? undefined) === note.mergedInto) {
      delete write.mergedInto;
    }
    if (what.kind === 'fields') {
      if (!t.before) {
        skipped.push({ id: t.id, title: note.title || t.title, why: 'unkept' });
        continue;
      }
      const fields: Record<string, FieldBefore> = {};
      const before: Record<string, FieldBefore> = {};
      for (const [k, v] of Object.entries(t.before)) {
        if (k === 'body') continue;
        const now = (note.fields?.[k] as FieldBefore | undefined) ?? null;
        if (JSON.stringify(now) === JSON.stringify(v)) continue;
        fields[k] = v;
        before[k] = now;
      }
      if (Object.keys(fields).length) Object.assign(write, { fields, before });
    }
    if ((what.kind === 'edited' || what.kind === 'fields') && what.text) {
      const before = textBefore.get(t.id);
      if (before === undefined) {
        skipped.push({ id: t.id, title: note.title || t.title, why: 'unkept' });
        if (write.archived === undefined && write.fields === undefined) continue;
      } else if (before !== note.body) {
        write.body = before;
        if (note.titleSource === 'words') {
          write.newTitle = firstWordsTitle(before);
          write.title = write.newTitle;
        }
        // Its own record names the text it replaces, so its put back finds it.
        if (what.kind === 'fields') write.before = { ...write.before, body: textHash(note.body) };
      }
    }
    if (
      write.archived !== undefined ||
      write.mergedInto !== undefined ||
      write.body !== undefined ||
      write.fields !== undefined
    )
      writes.push(write);
  }
  return { writes, skipped };
}

/** The put back's line in What assistants changed. */
export function putBackSummary(run: RunFacts, plan: Plan): string {
  const notes = (n: number) => (n === 1 ? 'a note' : `${n} notes`);
  const changed = plan.skipped.filter((s) => s.why === 'changed').length;
  const unkept = plan.skipped.filter((s) => s.why === 'unkept').length;
  return (
    `Put back “${run.summary}”` +
    (changed ? `; left ${notes(changed)} changed since alone` : '') +
    (unkept ? `; History no longer had the text before for ${notes(unkept)}` : '')
  );
}

/** Why nothing could be put back, for the gardener. */
export function nothingToPutBack(plan: Plan): string {
  if (plan.skipped.some((s) => s.why === 'changed'))
    return 'Its notes have changed since; open each note’s History to pick a version.';
  if (plan.skipped.some((s) => s.why === 'unkept'))
    return 'History no longer keeps the text from before it; open the note’s History.';
  if (plan.skipped.length) return 'Its notes are gone.';
  return 'Nothing it changed is left to put back.';
}
