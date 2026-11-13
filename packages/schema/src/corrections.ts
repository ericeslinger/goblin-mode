// Learn from the correction (#239, step 3 of #154): when Eric puts back
// an assistant's run, or files its notes again under another project
// (reroute, #235), the server notes the correction in his Context for
// Claude as one plain line under a heading of its own, so the next run
// knows (DESIGN.md, Learn from the correction). No model call: the line
// is read from the run's record, as the daily digest's is.
import { escapeMarkdown } from './reader';

/** The heading the lines gather under, in the context note. */
export const CORRECTIONS_HEADING = 'Corrections';

/** The most lines kept under it; older ones drop off. */
export const CORRECTIONS_MAX = 20;

/** A title longer than this is cut, with an ellipsis. */
const TITLE_MAX = 40;
/** A summary said as it is is cut at this. */
const SUMMARY_MAX = 160;

/** A note a correction names. */
export interface CorrectionNote {
  /** Its title as it is now. */
  title: string;
  /** Its title as the run's record has it, which the summary says; `title` if absent. */
  was?: string;
  /**
   * The title is a page's words (a clipping, a recipe imported from a
   * page): never put in the line, which goes to every run unlabelled
   * (CLAUDE.md, page text). Said as what it is instead.
   */
  web?: 'clipping' | 'recipe';
  /**
   * The note is sealed and the line goes into a context note stored
   * plain (step 3e, 2026-11-13): its title is never put in the line,
   * which would say it in the clear. Said as "a sealed note" instead.
   */
  sealed?: true;
}

/** How a correction line names a sealed note it may not quote (step 3e). */
export const SEALED_NAME = 'a sealed note';
/** How a correction line names a sealed project it may not quote (step 3e). */
export const SEALED_PROJECT_NAME = 'a sealed project';

/** A put back of an assistant's run, or a reroute after one. */
export type Correction =
  | {
      kind: 'put-back';
      /** The run put back: its tool, its summary, and its notes in record order. */
      tool: string;
      summary: string;
      notes: readonly CorrectionNote[];
      /** The project a filing filed under (a `refile` of `parent`), by title. */
      project?: string;
      /** The day, YYYY-MM-DD, on the house's clock. */
      day: string;
    }
  | {
      kind: 'reroute';
      /** The notes filed again. */
      notes: readonly CorrectionNote[];
      /** The project Eric filed them under, by title. */
      to: string;
      /** The project the assistant had filed them under, if any. */
      from?: string;
      /** For a merge put back: the note the assistant merged them into. */
      mergedInto?: CorrectionNote;
      day: string;
    };

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const WEB_NAME = { clipping: 'a clipping', recipe: 'an imported recipe' } as const;

/** A note's name in the line: its title, cut and escaped, or what it is when it is a page's. */
function name(n: CorrectionNote): string {
  if (n.sealed) return SEALED_NAME;
  if (n.web) return WEB_NAME[n.web];
  return escapeMarkdown(cut(oneLine(n.title) || 'Untitled', TITLE_MAX));
}

/** A project's name in the line. */
function project(title: string): string {
  return name({ title });
}

/** "A", "A and B", "A, B and C", or "A, B and 2 more". */
function list(notes: readonly CorrectionNote[]): string {
  const names = notes.map(name);
  if (names.length <= 1) return names[0] ?? 'a note';
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/**
 * A run's summary as the line says it: on one line, a page's titles
 * taken out, "a note" named where the run touched one, markdown's own
 * characters escaped, cut at `SUMMARY_MAX`.
 */
function summaryOf(summary: string, notes: readonly CorrectionNote[]): string {
  let text = oneLine(summary).replace(/[.]+$/, '');
  const marks: string[] = [];
  const mark = (said: string) => {
    marks.push(said);
    return `\u0000${marks.length - 1}\u0000`;
  };
  for (const n of notes) {
    if (!n.web && !n.sealed) continue;
    for (const t of [n.was, n.title]) {
      const words = oneLine(t ?? '');
      if (words) text = text.split(words).join(mark(name(n)));
    }
  }
  const [first] = notes;
  if (notes.length === 1 && first) {
    if (/\ba new note\b/.test(text))
      text = text.replace(
        /\ba new note\b/,
        mark(first.sealed ? 'a new sealed note' : `the note ${name(first)}`),
      );
    else text = text.replace(/\ba note\b/, mark(name(first)));
  }
  const said = escapeMarkdown(text).replace(/\u0000(\d+)\u0000/g, (_, i: string) => marks[+i]);
  return cut(said, SUMMARY_MAX);
}

/** What the run did, said for a put back. */
function didWhat(c: Extract<Correction, { kind: 'put-back' }>): string {
  const [first, ...rest] = c.notes;
  if (!first) return summaryOf(c.summary, c.notes);
  switch (c.tool) {
    case 'refile':
      if (c.project) return `Filed ${name(first)} under ${project(c.project)}`;
      break;
    case 'link_notes':
      if (rest.length) return `Linked ${name(first)} to ${list(rest)}`;
      break;
    case 'merge_notes':
      if (rest.length) return `Merged ${list(rest)} into ${name(first)}`;
      break;
    case 'split_note':
      if (rest.length) return `Split ${name(first)} into ${list(rest)}`;
      break;
    case 'finish_queued':
      return `Marked ${name(first)} done in the queue`;
  }
  return summaryOf(c.summary, c.notes);
}

/**
 * The one line a correction leaves under Corrections, a list item:
 * "- Put back: Filed Kiln log under Pottery (2026-11-10)." or "- Filed
 * Kiln log under Garden, not Pottery (2026-11-10)." Titles are cut at
 * 40 characters and escaped, so a `[[name]]` or `#tag` in one stays
 * words; a page's title is never said.
 */
export function correctionLine(c: Correction): string {
  if (c.kind === 'put-back') return `- Put back: ${didWhat(c)} (${c.day}).`;
  const not = c.from
    ? `, not ${project(c.from)}`
    : c.mergedInto
      ? `, not merged into ${name(c.mergedInto)}`
      : '';
  return `- Filed ${list(c.notes)} under ${project(c.to)}${not} (${c.day}).`;
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const ITEM = /^[-*+][ \t]/;

const isHeading = (line: string) =>
  HEADING.exec(line)?.[2]?.trim().toLowerCase() === CORRECTIONS_HEADING.toLowerCase();

/**
 * `body` with `line` added under the Corrections heading (any level,
 * the first one, matched without case), after the section's last line
 * of text, so newest last; the heading is added at the end, level 2,
 * if the note lacks it. Then only the last `max` list items under it
 * are kept: older items drop off, with the indented lines under them.
 * Everything else, other text under the heading included, stays as it
 * was, byte for byte.
 */
export function withCorrection(body: string, line: string, max = CORRECTIONS_MAX): string {
  if (!body) return `## ${CORRECTIONS_HEADING}\n${line}`;
  const lines = body.split('\n');
  const at = lines.findIndex(isHeading);
  if (at < 0) {
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    const head = lines.slice(0, end);
    return [
      ...head,
      ...(head.length ? [''] : []),
      `## ${CORRECTIONS_HEADING}`,
      line,
      ...lines.slice(end),
    ].join('\n');
  }
  const level = HEADING.exec(lines[at])![1].length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  let pos = end;
  while (pos > at + 1 && !lines[pos - 1].trim()) pos--;
  lines.splice(pos, 0, line);
  end++;
  // The section's items, each with the indented lines under it.
  const items: [number, number][] = [];
  for (let i = at + 1; i < end; i++) {
    if (!ITEM.test(lines[i])) continue;
    let j = i + 1;
    while (j < end && /^[ \t]+\S/.test(lines[j])) j++;
    items.push([i, j]);
    i = j - 1;
  }
  const drop = items.slice(0, Math.max(0, items.length - max));
  for (const [from, to] of drop.reverse()) lines.splice(from, to - from);
  return lines.join('\n');
}
