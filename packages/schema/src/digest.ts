// The daily digest (#237, step 4 of #154): a day's gardening in one
// line, read from that day's records in What assistants changed. Shared
// by the app, which shows yesterday's at the top of the list, and the
// scheduled push, which sends it at the hour the gardener picked. No
// model call: the records are grouped by what was done, by tool, and
// named from the notes each one lists (DESIGN.md, The daily digest).
import { addDays } from './mealplan';
import { PUT_BACK_TOOL, REROUTE_TOOL } from './putback';
import { zonedDay, zonedDayStart } from './reminders';

/**
 * The day before the one `now` falls on in `tz`, as its date and the
 * instants it runs between; `today` is where it ends.
 */
export function yesterdayIn(
  now: number,
  tz: string,
): { day: string; from: number; to: number; today: string } {
  const today = zonedDay(now, tz);
  const day = addDays(today, -1);
  return { day, from: zonedDayStart(day, tz), to: zonedDayStart(today, tz), today };
}

/** A record of What assistants changed, as the digest reads it; times in ms. */
export interface DigestRecord {
  at?: number;
  tool: string;
  summary: string;
  notes: readonly { id: string; title: string; made?: boolean; before?: unknown }[];
}

export interface DigestOptions {
  /** The day, as instants: from its start, up to and not including `to`. */
  from: number;
  to: number;
  /** What the sentence starts with, e.g. "Yesterday" or "Today so far". */
  label?: string;
  /**
   * Whether a note is a project, as it is now: a `link_notes` to one
   * reads as filing under it. Without it, every link is a link.
   */
  isProject?: (id: string) => boolean;
}

/** The most parts the assistants' work is said in before "and N more changes". */
export const DIGEST_PARTS = 4;
/** A title longer than this is cut, with an ellipsis. */
const TITLE_MAX = 40;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function name(title: string): string {
  const t = title.trim().replace(/\s+/g, ' ') || 'Untitled';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
}

/** "Kiln log", "Kiln log and Glazes", or "3 notes", then what was done. */
function named(titles: string[], done: string): string {
  if (titles.length === 1) return `${name(titles[0])} ${done}`;
  if (titles.length === 2) return `${name(titles[0])} and ${name(titles[1])} ${done}`;
  return `${titles.length} notes ${done}`;
}

/** One thing said in the sentence, and how many records it stands for. */
interface Part {
  text: string;
  runs: number;
  /** Sorts within its group, larger first. */
  weight: number;
}

/** Titles by note id, in the order first seen, and the records behind them. */
class Notes {
  readonly titles = new Map<string, string>();
  runs = 0;
  add(id: string, title: string) {
    if (!this.titles.has(id)) this.titles.set(id, title);
  }
  part(done: string): Part[] {
    const titles = [...this.titles.values()];
    return titles.length ? [{ text: named(titles, done), runs: this.runs, weight: 0 }] : [];
  }
}

/** The project a refile filed a note under, from its summary ("filed under Pottery"). */
function filedUnder(summary: string): string | undefined {
  return /\bfiled under (.+?)(?:;|$)/.exec(summary)?.[1]?.trim() || undefined;
}

/** How many lines an `add_lines` record says it added ("Added 3 lines to …"). */
function linesAdded(summary: string): number {
  const n = Number(/^Added (\d+) lines?\b/.exec(summary)?.[1]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * The digest sentence for the records between `from` and `to`, e.g.
 * "Yesterday: 4 notes filed under Pottery, 2 lines added to Kiln log,
 * Gift ideas made; you put back 1 change.", or undefined when nothing
 * changed. The assistants' work comes first, grouped by what was done
 * and named, at most `DIGEST_PARTS` parts and then "and N more
 * changes"; then Eric's own corrections, put backs and notes filed
 * again (a reroute), which are his, not an assistant's. A run he put
 * back is still counted: it happened, and the put back says so.
 */
export function digestSentence(
  records: readonly DigestRecord[],
  { from, to, label = 'Yesterday', isProject = () => false }: DigestOptions,
): string | undefined {
  const day = records.filter((r) => r.at !== undefined && r.at >= from && r.at < to);
  const filed = new Map<string, { title: string; notes: Set<string>; runs: number }>();
  const lines = new Map<string, { title: string; lines: number; runs: number }>();
  const made = new Notes();
  const edited = new Notes();
  const refiled = new Notes();
  const linked = new Notes();
  const archived = new Notes();
  const restored = new Notes();
  const answered = new Map<string, { title: string; items: number; runs: number }>();
  const merged: Part[] = [];
  const split: Part[] = [];
  let other = 0;
  let putBacks = 0;
  const filedAgain = new Set<string>();

  const file = (project: string, note: string) => {
    const key = project.toLowerCase();
    const group = filed.get(key) ?? { title: project, notes: new Set<string>(), runs: 0 };
    group.notes.add(note);
    group.runs++;
    filed.set(key, group);
  };

  day.forEach((r, i) => {
    const [first, ...rest] = r.notes;
    switch (r.tool) {
      case PUT_BACK_TOOL:
        putBacks++;
        return;
      case REROUTE_TOOL:
        for (const n of r.notes) filedAgain.add(n.id);
        if (!r.notes.length) filedAgain.add(`record-${i}`);
        return;
      case 'merge_notes':
        if (first) {
          merged.push({
            text: `${plural(rest.length, 'note')} merged into ${name(first.title)}`,
            runs: 1,
            weight: rest.length,
          });
          return;
        }
        break;
      case 'split_note':
        if (first) {
          split.push({
            text: `${name(first.title)} split into ${r.notes.length}`,
            runs: 1,
            weight: r.notes.length,
          });
          return;
        }
        break;
      case 'capture':
        // An idea or a question: its note is made, and the project's
        // page lists it; the project's record says it was filed.
        if (first?.made) return;
        if (first) {
          file(first.title.trim() || 'a project', `record-${i}`);
          return;
        }
        break;
      case 'add_lines':
        if (first) {
          const at = lines.get(first.id) ?? { title: first.title, lines: 0, runs: 0 };
          at.lines += linesAdded(r.summary);
          at.runs++;
          lines.set(first.id, at);
          return;
        }
        break;
      case 'answer_item':
        if (first) {
          const at = answered.get(first.id) ?? { title: first.title, items: 0, runs: 0 };
          at.items++;
          at.runs++;
          answered.set(first.id, at);
          return;
        }
        break;
      case 'refile':
        if (first) {
          const project = filedUnder(r.summary);
          if (project) file(project, first.id);
          else {
            refiled.add(first.id, first.title);
            refiled.runs++;
          }
          return;
        }
        break;
      case 'link_notes':
        if (first) {
          const project = rest.find((n) => isProject(n.id));
          if (project) file(project.title.trim() || 'a project', first.id);
          else {
            linked.add(first.id, first.title);
            linked.runs++;
          }
          return;
        }
        break;
      case 'archive_note':
      case 'update_note': {
        if (!first) break;
        const flips = /\bArchived a note\b/.test(r.summary)
          ? archived
          : /\bRestored a note\b/.test(r.summary)
            ? restored
            : undefined;
        if (flips) {
          flips.add(first.id, first.title);
          flips.runs++;
        }
        if (r.tool === 'update_note' && (!flips || /\bChanged a note's\b/.test(r.summary))) {
          edited.add(first.id, first.title);
          edited.runs++;
        }
        return;
      }
    }
    const fresh = r.notes.filter((n) => n.made);
    if (fresh.length) {
      for (const n of fresh) made.add(n.id, n.title);
      made.runs++;
    } else other++;
  });

  const byWeight = (parts: Part[]) => parts.sort((a, b) => b.weight - a.weight);
  const parts: Part[] = [
    ...byWeight(
      [...filed.values()].map((g) => ({
        text: `${plural(g.notes.size, 'note')} filed under ${name(g.title)}`,
        runs: g.runs,
        weight: g.notes.size,
      })),
    ),
    ...byWeight(
      [...lines.values()].map((l) => ({
        text: `${l.lines === 1 ? 'a line' : `${l.lines} lines`} added to ${name(l.title)}`,
        runs: l.runs,
        weight: l.lines,
      })),
    ),
    ...made.part('made'),
    ...edited.part('edited'),
    ...byWeight(
      [...answered.values()].map((a) => ({
        text: `${a.items === 1 ? 'an item' : `${a.items} items`} answered in ${name(a.title)}`,
        runs: a.runs,
        weight: a.items,
      })),
    ),
    ...byWeight(merged),
    ...byWeight(split),
    ...refiled.part('refiled'),
    ...linked.part('linked'),
    ...archived.part('archived'),
    ...restored.part('restored'),
  ];
  // "2 other changes" beside the rest; on their own, "2 changes".
  if (other)
    parts.push({
      text: plural(other, parts.length ? 'other change' : 'change'),
      runs: other,
      weight: 0,
    });

  const shown = parts.slice(0, DIGEST_PARTS);
  const more = parts.slice(DIGEST_PARTS).reduce((n, p) => n + p.runs, 0);
  const work = shown.map((p) => p.text);
  if (more) work.push(`and ${more} more ${more === 1 ? 'change' : 'changes'}`);

  const yours = [
    putBacks && `put back ${plural(putBacks, 'change')}`,
    filedAgain.size &&
      `filed ${filedAgain.size === 1 ? 'a note' : `${filedAgain.size} notes`} again`,
  ].filter((x): x is string => !!x);

  if (!work.length && !yours.length) return undefined;
  const said = [work.join(', '), yours.length ? `you ${yours.join(' and ')}` : '']
    .filter(Boolean)
    .join('; ');
  return `${label}: ${said}.`;
}
