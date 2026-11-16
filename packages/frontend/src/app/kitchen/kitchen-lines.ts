// What Kitchen's reading views show of a plan's and the pantry's text
// (#288, 2026-11-15): the week and the sections are drawn from the
// text, and whatever line they cannot draw is shown as plain words, so
// nothing typed becomes invisible. Display only: nothing here is ever
// written back.
import { plainText } from '@mossgoblin/editor/grammar';
import {
  FISH_ID,
  normalizeName,
  PANTRY_TITLE,
  type PantryItem,
  pantryItems,
  planSlots,
  shortDate,
} from '@mossgoblin/schema';

/** "Week of Nov 16", for a plan's first day. */
export function weekLabel(start: string): string {
  return `Week of ${shortDate(start)}`;
}

/** The week's own heading, as a new plan writes it, or its old name. */
const WEEK_HEADING = /^(meals, )?week of [a-z]{3} \d{1,2}$/i;

/**
 * The lines of a plan the week cannot show, as plain words: anything
 * that is not a slot, a note indented under one, a blank line or the
 * week's own heading. Lines with no words (a rule, a bare link mark)
 * are left out, being nothing to read.
 */
export function planExtras(body: string, start: string): string[] {
  const slots = planSlots(body, start);
  const shown = new Set<number>();
  for (const s of slots) for (let i = 0; i <= s.notes.length; i++) shown.add(s.line + i);
  return wordsOf(
    body,
    (line, i) => shown.has(i) || WEEK_HEADING.test(line.replace(/^#{1,6}[ \t]+/, '').trim()),
  );
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** One of the pantry's sections, as the reading view draws it. */
export interface PantrySection {
  /** The heading as written, '' for items before any heading. */
  heading: string;
  items: PantryItem[];
}

/**
 * The pantry's sections in order, each with its items; the items
 * before any heading first, under ''. Every heading is here, empty or
 * not: the reading view hides the empty ones, Add to offers them all.
 */
export function pantrySections(body: string): PantrySection[] {
  const sections: PantrySection[] = [{ heading: '', items: [] }];
  const items = pantryItems(body);
  let next = 0;
  body.split('\n').forEach((line, i) => {
    const h = HEADING.exec(line);
    if (h) sections.push({ heading: h[2], items: [] });
    while (next < items.length && items[next].line === i) {
      sections[sections.length - 1].items.push(items[next++]);
    }
  });
  return sections;
}

/** The sections worth reading: those with something under them. */
export function shownSections(sections: readonly PantrySection[]): PantrySection[] {
  return sections.filter((s) => s.items.length > 0);
}

/**
 * The pantry's lines that are neither items nor headings (a checkbox,
 * a sentence), as plain words; its name as a first line is not one.
 */
export function pantryExtras(body: string): string[] {
  const items = new Set(pantryItems(body).map((p) => p.line));
  const first = body.split('\n').findIndex((l) => l.trim());
  return wordsOf(
    body,
    (line, i) =>
      items.has(i) ||
      HEADING.test(line) ||
      (i === first && line.trim().toLowerCase() === PANTRY_TITLE.toLowerCase()),
  );
}

/** Each line not `skip`ped, as its plain words; blank results left out. */
function wordsOf(body: string, skip: (line: string, i: number) => boolean): string[] {
  const out: string[] = [];
  body.split('\n').forEach((line, i) => {
    if (!line.trim() || skip(line, i)) return;
    const words = plainText(line).replace(/\s+/g, ' ').trim();
    if (words) out.push(words);
  });
  return out;
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
