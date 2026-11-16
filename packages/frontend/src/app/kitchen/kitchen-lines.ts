// What Kitchen's reading views show of a plan's and the pantry's text
// (#288, 2026-11-15): the week and the sections are drawn from the
// text, and whatever line they cannot draw is shown as plain words, so
// nothing typed becomes invisible. Display only: nothing here is ever
// written back.
import { plainText } from '@mossgoblin/editor/grammar';
import {
  FISH_ID,
  normalizeName,
  type PantryItem,
  pantryItems,
  planSlots,
  shortDate,
} from '@mossgoblin/schema';

/** "Week of Nov 16", for a plan's first day. */
export function weekLabel(start: string): string {
  return `Week of ${shortDate(start)}`;
}

/** A line the reading view shows as plain words, and which line it is. */
export interface Extra {
  line: number;
  words: string;
}

/**
 * How a reading view accounts for a note's lines (#288, 2026-11-16):
 * every line that is not blank is drawn (a slot, a note under one, an
 * item, a heading, the week's own heading), shown as plain words
 * (`extras`), or counted among the lines with no words to show
 * (`wordless`: a rule, an image with no alt text, a code fence), which
 * the view says as "N more lines without words". None is shown nowhere.
 */
export interface PlanReading {
  /** The plan's own heading, drawn as the week's name; undefined if none. */
  heading?: number;
  /** The slots' lines and the notes under them, drawn as the week. */
  drawn: number[];
  extras: Extra[];
  wordless: number[];
}

/**
 * A plan's lines as the week reads them. Only the first line, and only
 * when it names this plan's own week ("Week of Nov 16", or the old
 * "Meals, week of Nov 16"), is the week's heading; another week's
 * heading or a free "Week of …" line is an extra like any other. With
 * no first day (`start` empty) nothing is a slot: every line is an
 * extra, so a plan without its week still shows all it holds.
 */
export function readPlan(body: string, start: string): PlanReading {
  const slots = start ? planSlots(body, start) : [];
  const drawn = new Set<number>();
  for (const s of slots) for (let i = 0; i <= s.notes.length; i++) drawn.add(s.line + i);
  const lines = body.split('\n');
  const first = lines.findIndex((l) => l.trim());
  const own = start ? weekLabel(start).toLowerCase() : undefined;
  const titled =
    own !== undefined &&
    first >= 0 &&
    !drawn.has(first) &&
    [own, `meals, ${own}`].includes(
      lines[first]
        .replace(/^#{1,6}[ \t]+/, '')
        .trim()
        .toLowerCase(),
    );
  const heading = titled ? first : undefined;
  const reading: PlanReading = {
    drawn: [...drawn].sort((a, b) => a - b),
    extras: [],
    wordless: [],
  };
  if (heading !== undefined) reading.heading = heading;
  lines.forEach((line, i) => {
    if (!line.trim() || drawn.has(i) || i === heading) return;
    sort(reading, line, i);
  });
  return reading;
}

/** A line as plain words, or among the wordless. */
function sort(into: { extras: Extra[]; wordless: number[] }, line: string, i: number): void {
  const words = plainText(line).replace(/\s+/g, ' ').trim();
  if (words) into.extras.push({ line: i, words });
  else into.wordless.push(i);
}

/** "2 more lines without words", or '' for none. */
export function wordlessLine(n: number): string {
  if (!n) return '';
  return `${n} more ${n === 1 ? 'line' : 'lines'} without words`;
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** One of the pantry's sections, as the reading view draws it. */
export interface PantrySection {
  /** The heading as written, '' for what comes before any heading. */
  heading: string;
  /** The heading's line; undefined for the part before any heading. */
  line?: number;
  items: PantryItem[];
  /** Its lines that are not items (a checkbox, a sentence), as plain words. */
  extras: Extra[];
  /** Its lines with no words to show. */
  wordless: number[];
}

/**
 * The pantry's sections in order, each with every line under it: its
 * items, its other lines as plain words, and those with no words; what
 * comes before any heading first, under ''. Every heading is here:
 * the reading view shows each with anything at all under it and hides
 * only those with nothing, which Add to still offers.
 */
export function pantrySections(body: string): PantrySection[] {
  const sections: PantrySection[] = [{ heading: '', items: [], extras: [], wordless: [] }];
  const items = new Map(pantryItems(body).map((p) => [p.line, p]));
  body.split('\n').forEach((line, i) => {
    const h = HEADING.exec(line);
    if (h) {
      sections.push({ heading: h[2], line: i, items: [], extras: [], wordless: [] });
      return;
    }
    if (!line.trim()) return;
    const here = sections[sections.length - 1];
    const item = items.get(i);
    if (item) here.items.push(item);
    else sort(here, line, i);
  });
  return sections;
}

/** The sections worth reading: those with any line under them. */
export function shownSections(sections: readonly PantrySection[]): PantrySection[] {
  return sections.filter((s) => s.items.length + s.extras.length + s.wordless.length > 0);
}

export type RecipeSort = 'name' | 'made';

/** A row of the Recipes tab. */
export interface RecipeRow {
  id: string;
  title: string;
  /** How often it was made; 0 for never. */
  times: number;
  /** The last day it was made, YYYY-MM-DD, or '' for never. */
  last: string;
  /** "made 3×, last Nov 2", or '' for a recipe never made. */
  made: string;
}

/**
 * The recipe book as the Recipes tab lists it: every live recipe but
 * the Fish of the week placeholder (by its id, whatever its name),
 * those whose name holds the search as typed (any case), A to Z, or
 * with Made lately the most lately made first, then those never made,
 * A to Z.
 */
export function recipeRows(
  notes: readonly { id: string; kind?: string; archived?: boolean; title: string }[],
  made: ReadonlyMap<string, readonly string[]>,
  query: string,
  sort: RecipeSort,
): RecipeRow[] {
  const want = query.trim().toLowerCase();
  const byName = (a: RecipeRow, b: RecipeRow) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  const rows = notes
    .filter((n) => n.kind === 'recipe' && !n.archived && n.id !== FISH_ID)
    .filter((n) => !want || n.title.toLowerCase().includes(want))
    .map((n): RecipeRow => {
      const dates = made.get(normalizeName(n.title)) ?? [];
      const last = dates[dates.length - 1] ?? '';
      return {
        id: n.id,
        title: n.title,
        times: dates.length,
        last,
        made: dates.length ? `made ${dates.length}×, last ${shortDate(last)}` : '',
      };
    });
  return rows.sort(
    sort === 'made' ? (a, b) => b.last.localeCompare(a.last) || byName(a, b) : byName,
  );
}
