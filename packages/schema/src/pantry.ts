// What is on hand (#131, epic #125, Kitchen module), presence only: one
// note, id `pantry`, a line per item under the store's sections:
//
//   ## Produce
//   - onions: 3
//   - lemons
//   ## Dry goods
//   - olive oil: always
//
// Eric edits it like any note. Done shopping adds what was ticked; a
// dinner ticked made takes off what its recipe used, except what is
// marked `always`; a planned dinner skips what is here. Only the lines
// named change, so it merges with typing and Claude's edits (#37).
// Amounts are kept as written and not counted yet (#133).
import { itemKey } from './grocery';
import { ingredients } from './recipes';

export const PANTRY_ID = 'pantry';
/** Where an item with no store section goes. */
export const OTHER = 'Other';
export const PANTRY_TITLE = 'On hand';
/** The pantry's text when first made: its name and the store's sections. */
export const PANTRY_BODY = '## Produce\n\n## Butcher\n\n## Dry goods\n';

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
/** An item line: a bullet, never a checkbox. */
const ITEM = /^\s*[-*+]\s+(?!\[[ xX]\])(.*?\S)\s*$/;
const ALWAYS = /^always$/i;

export interface PantryItem {
  /** Which line of the body (0-based). */
  line: number;
  /** The item as written, before any colon. */
  item: string;
  /** What it is for matching: normalized, its amount and unit off. */
  key: string;
  /** What follows the colon, as written ("3", "half a bag"). */
  amount?: string;
  /** Marked `always`: never taken off. */
  always: boolean;
  /** The section it is under, '' before any. */
  section: string;
}

/** The pantry's items, in order. */
export function pantryItems(body: string): PantryItem[] {
  const out: PantryItem[] = [];
  let section = '';
  body.split('\n').forEach((l, line) => {
    const h = HEADING.exec(l);
    if (h) {
      section = h[2];
      return;
    }
    const m = ITEM.exec(l);
    if (!m) return;
    const colon = m[1].lastIndexOf(':');
    const item = (colon > 0 ? m[1].slice(0, colon) : m[1]).trim();
    const amount = colon > 0 ? m[1].slice(colon + 1).trim() : '';
    out.push({
      line,
      item,
      key: itemKey(item),
      ...(amount && !ALWAYS.test(amount) ? { amount } : {}),
      always: ALWAYS.test(amount),
      section,
    });
  });
  return out;
}

/** What is on hand, by key, for the grocery list to skip (#130). */
export function onHand(body: string): Set<string> {
  return new Set(pantryItems(body).map((p) => p.key));
}

/** After a section's last line of text, or a new section at the end. */
function insertUnder(lines: string[], heading: string, add: string[]): void {
  const at = lines.findIndex((l) => HEADING.exec(l)?.[2].toLowerCase() === heading.toLowerCase());
  if (at === -1) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('', `## ${heading}`, '', ...add, '');
    return;
  }
  let end = at + 1;
  while (end < lines.length && !HEADING.test(lines[end])) end++;
  let last = end;
  while (last > at + 1 && !lines[last - 1].trim()) last--;
  lines.splice(last, 0, ...(last === at + 1 ? ['', ...add] : add));
}

/** The item a list line bought, as the pantry writes it: no amount, no dinner. */
function boughtName(text: string): string {
  const bare = text
    .replace(/\s+\(([^()]+), (Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?: (breakfast|lunch))?\)$/, '')
    .replace(/\s+×\s*[\d.]+$/, '')
    .replace(/\s*★\s*/g, ' ')
    .trim();
  const parsed = ingredients(`## Ingredients\n- ${bare}`)[0];
  return (parsed?.item || bare).trim();
}

/**
 * The pantry with what was bought added (Done shopping): each item not
 * here yet goes under the section it was in on the list, or a new one.
 */
export function addBought(
  body: string,
  bought: readonly { text: string; section: string }[],
): { body: string; added: string[] } {
  const have = onHand(body);
  const lines = body.split('\n');
  const added: string[] = [];
  const bySection = new Map<string, string[]>();
  for (const { text, section } of bought) {
    const name = boughtName(text);
    const key = itemKey(name);
    if (!name || have.has(key)) continue;
    have.add(key);
    added.push(name);
    // Not under a store section on the list: under Other, so it never
    // reads as part of the pantry's last section.
    const where = !section || /^(from recipes|got it)$/i.test(section) ? OTHER : section;
    bySection.set(where, [...(bySection.get(where) ?? []), `- ${name}`]);
  }
  for (const [section, items] of bySection) insertUnder(lines, section, items);
  return { body: added.length ? lines.join('\n') : body, added };
}

/** The pantry without the lines named by `keys`, except items marked always. */
export function useUp(body: string, keys: ReadonlySet<string>): { body: string; used: string[] } {
  const gone = new Map(
    pantryItems(body)
      .filter((p) => keys.has(p.key) && !p.always)
      .map((p) => [p.line, p.item]),
  );
  if (!gone.size) return { body, used: [] };
  return {
    body: body
      .split('\n')
      .filter((_, i) => !gone.has(i))
      .join('\n'),
    used: [...gone.values()],
  };
}

/** What a recipe uses, by key, for a dinner made. */
export function recipeKeys(recipeBody: string): Set<string> {
  return new Set(ingredients(recipeBody).map((i) => itemKey(i.item || i.text)));
}

/**
 * The pantry with lines changed as Claude asks (#131): items added (to
 * a section, with an amount or `always`), removed, or marked always.
 * Only the lines named change; Eric's other lines stay as written.
 */
export function editPantry(
  body: string,
  change: {
    add?: readonly { item: string; amount?: string; always?: boolean; section?: string }[];
    remove?: readonly string[];
    always?: readonly string[];
  },
): string {
  const items = pantryItems(body);
  const lines = body.split('\n');
  const byKey = new Map(items.map((p) => [p.key, p]));
  for (const name of change.always ?? []) {
    const p = byKey.get(itemKey(name));
    if (p && !p.always) lines[p.line] = lines[p.line].replace(/(:\s*[^:]*)?\s*$/, ': always');
  }
  const remove = new Set((change.remove ?? []).map(itemKey));
  const removeLines = new Set(items.filter((p) => remove.has(p.key)).map((p) => p.line));
  const kept = lines.filter((_, i) => !removeLines.has(i));
  const have = new Set(items.filter((p) => !remove.has(p.key)).map((p) => p.key));
  const bySection = new Map<string, string[]>();
  for (const a of change.add ?? []) {
    const name = a.item.trim().replace(/:/g, ' ');
    const key = itemKey(name);
    if (!name || have.has(key)) continue;
    have.add(key);
    const tail = a.always ? ': always' : a.amount?.trim() ? `: ${a.amount.trim()}` : '';
    const section = a.section?.trim() || OTHER;
    bySection.set(section, [...(bySection.get(section) ?? []), `- ${name}${tail}`]);
  }
  for (const [section, add] of bySection) insertUnder(kept, section, add);
  return kept.join('\n');
}
