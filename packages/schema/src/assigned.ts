// A checklist item handed to the assistant (#144 step 4): one ending in
// `@goblin`. The garden's own agent researches it on the web and writes
// what it found under the item, then ticks it. Read from the note's
// text; the server's writes change only the lines they are about.
import { normalizeName } from './concepts';

/** What marks an item as the assistant's, at the end of its text. */
export const GOBLIN_MENTION = '@goblin';
/** How the assistant's findings start, so their origin is plain. */
export const FINDINGS_MARK = '✳ Mossgoblin, from the web:';
/** How a line saying why an item could not be done starts. */
export const STATUS_MARK = '✳ Mossgoblin:';
/** The most of the findings kept, in characters. */
export const FINDINGS_MAX = 2000;

const TASK = /^(\s*)([-*+]\s+\[)([ xX])(\]\s+)(.*\S)(\s*)$/;
const MENTION = /\s*@goblin\s*$/i;

export interface AssignedItem {
  /** Which line of the body (0-based). */
  line: number;
  /** The ask, as written, without the mention. */
  text: string;
  /** What names it across edits elsewhere in the note. */
  key: string;
  done: boolean;
}

/** The items assigned to the assistant, ticked or not, in order. */
export function assignedItems(body: string): AssignedItem[] {
  const out: AssignedItem[] = [];
  body.split('\n').forEach((l, line) => {
    const m = TASK.exec(l);
    if (!m || !MENTION.test(m[5])) return;
    const text = m[5].replace(MENTION, '').trim();
    if (!text) return;
    out.push({ line, text, key: normalizeName(text), done: m[3] !== ' ' });
  });
  return out;
}

/**
 * The body with `lines` written under the item named by `key`, indented
 * one level below it, and the item ticked. The item is found again by
 * its key, so lines moved since do not matter; gone, nothing changes.
 */
export function answerItem(
  body: string,
  key: string,
  lines: readonly string[],
  tick = true,
): { body: string; changed: boolean } {
  const item = assignedItems(body).find((i) => i.key === key && !i.done);
  if (!item) return { body, changed: false };
  const all = body.split('\n');
  const m = TASK.exec(all[item.line])!;
  const indent = `${m[1]}  `;
  if (tick) {
    // Only the mark changes; the line's own spacing stays as written.
    all[item.line] = all[item.line].replace(
      TASK,
      (_, lead, open, _mark, close, text, tail) => `${lead}${open}x${close}${text}${tail}`,
    );
  }
  const add = lines.map((l) => (l.trim() ? `${indent}${l}` : ''));
  // A line saying why it could not be done replaces the last such line,
  // so a retry never piles them up (review on #158).
  const next = all[item.line + 1];
  if (!tick && next !== undefined && next.trim().startsWith(`- ${STATUS_MARK}`)) {
    all.splice(item.line + 1, 1, ...add);
  } else {
    all.splice(item.line + 1, 0, ...add);
  }
  return { body: all.join('\n'), changed: true };
}

/**
 * One line of findings as plain words (review on #158): a page can make
 * the model emit a checkbox, an `@goblin`, a link, a tag or markup, and
 * written into a note those would be read as Eric's. Only words stay.
 */
export function neutralise(line: string): string {
  return line
    .replace(/<[^>]*>/g, ' ')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX]\]\s*/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/@goblin/gi, 'goblin')
    .replace(/(^|\s)#(?=\p{L})/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The findings as lines under an item: the mark, then the text's lines as bullets. */
export function findingsLines(text: string): string[] {
  const cut = text.trim().slice(0, FINDINGS_MAX).trim();
  const body = cut
    .split('\n')
    .map(neutralise)
    .filter(Boolean)
    .map((l) => `- ${l}`);
  return [`- ${FINDINGS_MARK}`, ...body.map((l) => `  ${l}`)];
}
