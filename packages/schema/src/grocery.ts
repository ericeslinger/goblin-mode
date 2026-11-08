// The grocery list fed by the meal plan (#130, epic #125): planning a
// recipe adds its ingredients to the living Shopping list, scaled by the
// dinner's ratio. Since #207 (Eric, 2026-11-08) a line is only the item,
// `- [ ] 2 onions`; which dinner wants it is said on the list's back,
// worked out from the week's plan (`listSources`). A line goes under the
// section its item was filed in last time, else under From recipes.
// Unplanning takes away the lines that dinner put on (recorded in
// Kitchen's `wrote`, #207) that are still unticked and as written; a
// line Eric ticked, edited or wrote himself stays. Every change touches
// only the lines it is about, so it merges with typing and Claude's line
// edits (#37). Each week has its own list (#207): the first dinner
// planned into a newer week starts one and the old one is archived.
import { STAPLE } from './checklist';
import { normalizeName } from './concepts';
import { shortDate } from './mealplan';
import { type Ingredient, ingredients } from './recipes';
import { templateParts } from './templates';

/** Where a planned dinner's line goes when its item has no section yet. */
export const FROM_RECIPES = 'From recipes';

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;
/** The dinner a line was for, at its end, as lists before #207 say: "(Shakshuka, Mon)". */
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

/** The item a recipe's ingredient stands for, as the list matches it. */
function ingredientKey(ing: Ingredient): string {
  return normalizeName(ing.item || ing.text);
}

/**
 * The lines a planned dinner adds: its recipe's ingredients, scaled.
 * Only the item (#207): the dinner is named on the list's back.
 */
export function dinnerLines(recipeBody: string, ratio = 1): { key: string; line: string }[] {
  return ingredients(recipeBody).map((ing) => ({
    key: ingredientKey(ing),
    line: `- [ ] ${scaledText(ing, ratio)}`,
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
 * `lines` are the ones put on, for the record of what a dinner wrote.
 */
export function addDinner(
  listBody: string,
  add: readonly { key: string; line: string }[],
  remembered: Readonly<Record<string, string>> = {},
  skip: ReadonlySet<string> = new Set(),
): { body: string; added: number; lines: string[] } {
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
  const put: string[] = [];
  for (const [section, items] of bySection) {
    insertUnder(lines, section, items);
    put.push(...items);
  }
  return { body: put.length ? lines.join('\n') : listBody, added: put.length, lines: put };
}

/**
 * The list without the lines a dinner wrote (`wrote`, as recorded when
 * they went on) that are still unticked and still read exactly as
 * written; a line ticked or edited stays, and so does any line the
 * dinner did not write, Eric's own `- [ ] limes` among them (#207). Each
 * recorded line takes off one line at most.
 */
export function removeDinner(
  listBody: string,
  wrote: readonly { key: string; line: string }[],
): { body: string; removed: number; keys: Set<string> } {
  const ours = new Map<string, { key: string; left: number }>();
  for (const w of wrote) {
    const had = ours.get(w.line);
    ours.set(w.line, { key: w.key, left: (had?.left ?? 0) + 1 });
  }
  const keys = new Set<string>();
  const lines = listBody.split('\n');
  const kept = lines.filter((l) => {
    const mine = ours.get(l.trimEnd());
    if (!mine?.left) return true;
    mine.left--;
    keys.add(mine.key);
    return false;
  });
  return { body: kept.join('\n'), removed: lines.length - kept.length, keys };
}

/** A planned dinner, as the grocery list needs it. */
export interface PlannedDinner {
  /** The recipe's name, as the slot links it. */
  recipe: string;
  recipeBody: string;
  day: string;
  ratio?: number;
  /** Its slot's key in the record of what dinners wrote (`slotKey`, #207). */
  slot?: string;
}

/**
 * A slot's key in Kitchen's record of the lines each dinner put on the
 * list (`wrote`, #207): its plan's first day, day and meal,
 * "2026-10-19/Mon/dinner".
 */
export function slotKey(start: string, day: string, meal: string): string {
  return `${start}/${day}/${meal}`;
}

/**
 * The record without the slots of weeks older than the list's (#207),
 * so it stays small; a list with no week keeps it all.
 */
export function pruneWrote(
  wrote: Readonly<Record<string, string[]>>,
  listStart: string | undefined,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(wrote).filter(
      ([key, lines]) => lines.length && (!listStart || key.split('/')[0] >= listStart),
    ),
  );
}

/**
 * The list after one slot changed from `before` to `after`: the old
 * dinner's untouched lines out, the new dinner's lines in. Either may
 * be absent (planned onto an empty slot, or cleared). The same dinner
 * on both sides changes nothing. Only the lines `wrote` records for the
 * old dinner's slot come off (#207); a slot with none recorded (planned
 * before the record was kept) takes nothing off. The record comes back
 * with the old slot's lines gone and the new ones in.
 */
export function replanGrocery(
  listBody: string,
  before: PlannedDinner | undefined,
  after: PlannedDinner | undefined,
  remembered: Readonly<Record<string, string>> = {},
  skip: ReadonlySet<string> = new Set(),
  /** The plan's other dinners: one that needs an item taken off gets its own line. */
  others: readonly PlannedDinner[] = [],
  wrote: Readonly<Record<string, string[]>> = {},
): { body: string; added: number; removed: number; wrote: Record<string, string[]> } {
  const lines = (d: PlannedDinner) => dinnerLines(d.recipeBody, d.ratio ?? 1);
  const record: Record<string, string[]> = { ...wrote };
  const same =
    before &&
    after &&
    normalizeName(before.recipe) === normalizeName(after.recipe) &&
    before.day === after.day &&
    (before.ratio ?? 1) === (after.ratio ?? 1);
  if (same) return { body: listBody, added: 0, removed: 0, wrote: record };
  let out = { body: listBody, removed: 0, keys: new Set<string>() };
  if (before?.slot) {
    const keyOf = new Map(lines(before).map((l) => [l.line, l.key]));
    const recorded = (record[before.slot] ?? []).map((line) => ({
      line,
      key: keyOf.get(line) ?? itemKey(line.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')),
    }));
    out = removeDinner(listBody, recorded);
  }
  if (before?.slot) delete record[before.slot];
  const note = (slot: string | undefined, put: string[]) => {
    if (slot && put.length) record[slot] = [...(record[slot] ?? []), ...put];
  };
  let body = out.body;
  let added = 0;
  if (after) {
    const next = addDinner(body, lines(after), remembered, skip);
    body = next.body;
    added += next.added;
    note(after.slot, next.lines);
  }
  // An item the old dinner's line stood for that another dinner on the
  // plan still needs (the same recipe twice in a week) goes back on, as
  // that dinner writes it and recorded as its own (review on #139). Only
  // those: a line Eric deleted himself is not brought back.
  for (const other of others) {
    if (!out.keys.size) break;
    const wanted = lines(other).filter((l) => out.keys.has(l.key));
    const next = addDinner(body, wanted, remembered, skip);
    body = next.body;
    added += next.added;
    note(other.slot, next.lines);
  }
  return { body, added, removed: out.removed, wrote: record };
}

/** How the list's back names a meal: "Mon" for a dinner, "Mon lunch" otherwise. */
export function mealLabel(day: string, meal: string): string {
  return meal === 'dinner' ? day : `${day} ${meal}`;
}

/** The template whose living note is the grocery list, until Kitchen names one. */
export const SHOPPING_LIST_NAME = 'Shopping list';

/**
 * A week's list's id (#207), from the week's first day, as a plan's is:
 * shopping-2026-10-19, so the phone offline and Claude start the same
 * note.
 */
export function shoppingListId(start: string): string {
  return `shopping-${start}`;
}

/** A week's list's name: "Shopping list, week of Oct 19". */
export function shoppingListTitle(start: string): string {
  return `Shopping list, week of ${shortDate(start)}`;
}

/**
 * Whether a dinner planned into the week starting `start` wants a new
 * list (#207): the list's week is older. A list with no week (made
 * before #207) is not older: it is taken as that week's list instead.
 */
export function listIsOlder(listStart: string | undefined, start: string): boolean {
  return !!listStart && listStart < start;
}

const MEAL_PLAN_HEADING = /^(#{1,6})[ \t]+Meal plan[ \t]*#*[ \t]*$/im;

/**
 * What a new list starts as, from the Shopping list template: its text
 * without the Instructions for Claude, and without the Meal plan section
 * a template from before #130 still has (the plan is its own note).
 * Given the list it follows (#207), that list's staples (★) come along,
 * unticked, under the sections they were in, since they stay from week
 * to week; nothing else does.
 */
export function shoppingListBody(
  templateBody: string,
  instructions?: string,
  previous?: string,
): string {
  let body = templateParts(templateBody, instructions).skeleton;
  const m = MEAL_PLAN_HEADING.exec(body);
  if (m) {
    const after = m.index + m[0].length;
    const next = new RegExp(`^#{1,${m[1].length}}[ \\t]+\\S`, 'm').exec(body.slice(after));
    const end = next ? after + next.index : body.length;
    body = `${body.slice(0, m.index).trimEnd()}\n\n${body.slice(end).trimStart()}`.trim();
  }
  if (!previous) return body;
  const staples: { key: string; line: string }[] = [];
  const filed: Record<string, string> = {};
  let heading = '';
  for (const l of previous.split('\n')) {
    const h = HEADING.exec(l);
    if (h) heading = h[2];
    const task = TASK.exec(l);
    if (!task || !task[2].includes(STAPLE)) continue;
    const key = itemKey(task[2]);
    staples.push({ key, line: `- [ ] ${task[2]}` });
    if (heading) filed[key] = heading;
  }
  return addDinner(body, staples, filed).body;
}

/** One open item on a list and the planned dinners that need it (#207). */
export interface ItemSource {
  /** The item as the list has it. */
  item: string;
  /** "Shakshuka (Mon)", one per dinner. */
  dinners: string[];
}

/**
 * Which of the week's dinners need each open item on the list (#207),
 * worked out each time from the plan and the recipes, never stored: an
 * item matches an ingredient as the list matches it (`itemKey`). An item
 * no dinner needs is left out. `dinners` name their meal in `day`
 * ("Mon", "Mon lunch").
 */
export function listSources(listBody: string, dinners: readonly PlannedDinner[]): ItemSource[] {
  const needs = dinners.map((d) => ({
    label: `${d.recipe} (${d.day})`,
    keys: new Set(ingredients(d.recipeBody).map(ingredientKey)),
  }));
  const out: ItemSource[] = [];
  for (const l of listBody.split('\n')) {
    const task = TASK.exec(l);
    if (!task || task[1] !== ' ') continue;
    const key = itemKey(task[2]);
    const by = [...new Set(needs.filter((n) => n.keys.has(key)).map((n) => n.label))];
    if (by.length) out.push({ item: task[2], dinners: by });
  }
  return out;
}
