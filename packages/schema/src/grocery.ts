// The grocery list fed by the meal plan (#130, epic #125): planning a
// recipe adds its ingredients to the living Shopping list, each line
// naming the dinner it is for, `- [ ] 2 onions (Shakshuka, Mon)`, scaled
// by the dinner's ratio. A line goes under the section its item was
// filed in last time, else under From recipes. Unplanning takes away
// the dinner's lines that are still unticked and as written; a line
// Eric ticked or edited stays. Every change touches only the lines it
// is about, so it merges with typing and Claude's line edits (#37).
import { normalizeName } from './concepts';
import { type Ingredient, ingredients } from './recipes';

/** Where a planned dinner's line goes when its item has no section yet. */
export const FROM_RECIPES = 'From recipes';

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;
/** The dinner a line is for, at its end: "(Shakshuka, Mon)". */
const FOR_DINNER = /\s+\(([^()]+), (Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?: (breakfast|lunch))?\)$/;

/** What a list line is for: its item, normalized, without the dinner. */
export function itemKey(text: string): string {
  const bare = text.replace(FOR_DINNER, '').replace(/\s+×\s*[\d.]+$/, '');
  return normalizeName(itemOf(bare));
}

/** The item a line buys: its words after any amount and unit. */
function itemOf(text: string): string {
  // Ingredients parse the same way whether in a recipe or on the list.
  const parsed = ingredients(`## Ingredients\n- ${text}`)[0];
  return parsed?.item || text;
}

/** An amount, as short as it reads: 1, 1.5, 0.25. */
function amountText(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * One ingredient as a list line's text, its amount scaled by `ratio`.
 * An amount that is a range, or none, is kept as written with the
 * ratio after it ("salt ×0.5"), so nothing is guessed.
 */
export function scaledText(ing: Ingredient, ratio = 1): string {
  const text = ing.text.trim();
  if (ratio === 1) return text;
  const single = ing.quantity !== undefined && !/-|–|\bto\b/.test(ing.quantity);
  if (ing.amount !== undefined && single && text.startsWith(ing.quantity!)) {
    return `${amountText(ing.amount * ratio)}${text.slice(ing.quantity!.length)}`;
  }
  return `${text} ×${amountText(ratio)}`;
}

/** The lines a planned dinner adds: its recipe's ingredients, scaled and named. */
export function dinnerLines(
  recipeBody: string,
  recipe: string,
  day: string,
  ratio = 1,
): { key: string; line: string }[] {
  return ingredients(recipeBody).map((ing) => ({
    key: normalizeName(ing.item || ing.text),
    line: `- [ ] ${scaledText(ing, ratio)} (${recipe}, ${day})`,
  }));
}

/** Item to section, from where the list files things now. */
export function listSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let heading = '';
  for (const l of body.split('\n')) {
    const h = HEADING.exec(l);
    if (h) {
      heading = h[2];
      continue;
    }
    const task = TASK.exec(l);
    if (task && heading && heading !== FROM_RECIPES && !/^meal plan$/i.test(heading)) {
      out[itemKey(task[2])] = heading;
    }
  }
  return out;
}

/** The unticked items on the list, by key. */
function openItems(body: string): Set<string> {
  const out = new Set<string>();
  for (const l of body.split('\n')) {
    const task = TASK.exec(l);
    if (task && task[1] === ' ') out.add(itemKey(task[2]));
  }
  return out;
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

/**
 * The list with a planned dinner's lines added: each under the section
 * its item was filed in (the list's own sections first, then
 * `remembered`), else under From recipes. An item already on the list
 * unticked is skipped, and so is one in `skip` (what is on hand, #131).
 */
export function addDinner(
  listBody: string,
  add: readonly { key: string; line: string }[],
  remembered: Readonly<Record<string, string>> = {},
  skip: ReadonlySet<string> = new Set(),
): { body: string; added: number } {
  const open = openItems(listBody);
  const sections = { ...remembered, ...listSections(listBody) };
  const bySection = new Map<string, string[]>();
  for (const { key, line } of add) {
    if (open.has(key) || skip.has(key)) continue;
    open.add(key);
    const section = sections[key] ?? FROM_RECIPES;
    bySection.set(section, [...(bySection.get(section) ?? []), line]);
  }
  const lines = listBody.split('\n');
  let added = 0;
  for (const [section, items] of bySection) {
    insertUnder(lines, section, items);
    added += items.length;
  }
  return { body: added ? lines.join('\n') : listBody, added };
}

/**
 * The list without a dinner's lines that are still unticked and still
 * read exactly as the dinner wrote them; a line ticked or edited stays.
 */
export function removeDinner(
  listBody: string,
  wrote: readonly { line: string }[],
): { body: string; removed: number } {
  const ours = new Set(wrote.map((w) => w.line));
  const lines = listBody.split('\n');
  const kept = lines.filter((l) => !ours.has(l.trimEnd()));
  return { body: kept.join('\n'), removed: lines.length - kept.length };
}

/** A planned dinner, as the grocery list needs it. */
export interface PlannedDinner {
  /** The recipe's name, as the slot links it. */
  recipe: string;
  recipeBody: string;
  day: string;
  ratio?: number;
}

/**
 * The list after one slot changed from `before` to `after`: the old
 * dinner's untouched lines out, the new dinner's lines in. Either may
 * be absent (planned onto an empty slot, or cleared). The same dinner
 * on both sides changes nothing.
 */
export function replanGrocery(
  listBody: string,
  before: PlannedDinner | undefined,
  after: PlannedDinner | undefined,
  remembered: Readonly<Record<string, string>> = {},
  skip: ReadonlySet<string> = new Set(),
): { body: string; added: number; removed: number } {
  const lines = (d: PlannedDinner) => dinnerLines(d.recipeBody, d.recipe, d.day, d.ratio ?? 1);
  const same =
    before &&
    after &&
    normalizeName(before.recipe) === normalizeName(after.recipe) &&
    before.day === after.day &&
    (before.ratio ?? 1) === (after.ratio ?? 1);
  if (same) return { body: listBody, added: 0, removed: 0 };
  const out = before ? removeDinner(listBody, lines(before)) : { body: listBody, removed: 0 };
  const added = after
    ? addDinner(out.body, lines(after), remembered, skip)
    : { body: out.body, added: 0 };
  return { body: added.body, added: added.added, removed: out.removed };
}

/** How a list line names its meal: "Mon" for a dinner, "Mon lunch" otherwise. */
export function mealLabel(day: string, meal: string): string {
  return meal === 'dinner' ? day : `${day} ${meal}`;
}

/** The template whose living note is the grocery list, until Kitchen names one. */
export const SHOPPING_LIST_NAME = 'Shopping list';
