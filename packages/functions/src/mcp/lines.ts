// Line-level edits for Claude (#37): add lines under a heading, tick or
// untick a checklist item. Each is applied to the note's current text
// in a transaction, so it never replaces text written meanwhile, and it
// changes only the lines it names: the gardener's text stays verbatim.

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const TASK = /^(\s*[-*+]\s+\[)([ xX])(\](?:\s+|$))(.*)$/;

const norm = (s: string) =>
  s
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Where a heading's section ends: the next heading at its level or above. */
function sectionEnd(lines: readonly string[], at: number, level: number): number {
  for (let i = at + 1; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (m && m[1].length <= level) return i;
  }
  return lines.length;
}

/** Index after the last non-blank line in [from, to), or `from` if none. */
function afterText(lines: readonly string[], from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (lines[i].trim()) return i + 1;
  return from;
}

/**
 * Adds `add` under `heading` (any level, matched without case), after
 * the section's last line of text; a heading the note lacks is added at
 * the end as a level-2 heading. Without a heading, at the end.
 */
export function addLines(body: string, add: readonly string[], heading?: string): string {
  const lines = body.split('\n');
  const want = heading === undefined ? undefined : norm(heading);
  if (want !== undefined) {
    const at = lines.findIndex((l) => {
      const m = HEADING.exec(l);
      return m !== null && norm(m[2]) === want;
    });
    if (at >= 0) {
      const level = HEADING.exec(lines[at])![1].length;
      const end = sectionEnd(lines, at, level);
      const pos = afterText(lines, at + 1, end);
      lines.splice(pos === at + 1 ? at + 1 : pos, 0, ...add);
      return lines.join('\n');
    }
  }
  const end = afterText(lines, 0, lines.length);
  const tail = lines.slice(end);
  const head = lines.slice(0, end);
  const block =
    want === undefined ? [...add] : [...(head.length ? [''] : []), `## ${heading!.trim()}`, ...add];
  return [...head, ...block, ...tail].join('\n');
}

/** A checklist item a body has, with its line. */
interface Item {
  line: number;
  text: string;
  done: boolean;
}

function items(lines: readonly string[]): Item[] {
  return lines.flatMap((l, line) => {
    const m = TASK.exec(l);
    return m ? [{ line, text: m[4], done: m[2] !== ' ' }] : [];
  });
}

/**
 * Ticks (`done`) or unticks the checklist item named `item`: the one
 * whose text matches without case, or the only one containing it.
 * Returns the new body and the item's text, or why not.
 */
export function setItem(
  body: string,
  item: string,
  done: boolean,
): { body: string; text: string; changed: boolean } | string {
  const lines = body.split('\n');
  const all = items(lines);
  const want = norm(item);
  if (!want) return 'name the item';
  let found = all.filter((i) => norm(i.text) === want);
  if (found.length === 0) found = all.filter((i) => norm(i.text).includes(want));
  if (found.length === 0) {
    return all.length
      ? `no item matches "${item}"; the items are: ${all.map((i) => i.text).join('; ')}`
      : 'the note has no checklist items';
  }
  if (found.length > 1) {
    // The same name ticked and not: take the one this changes.
    const open = found.filter((i) => i.done !== done);
    if (open.length !== 1)
      return `"${item}" matches several items: ${found.map((i) => i.text).join('; ')}`;
    found = open;
  }
  const [hit] = found;
  if (hit.done === done) return { body, text: hit.text, changed: false };
  lines[hit.line] = lines[hit.line].replace(
    TASK,
    (_, open, _mark, close, text) => `${open}${done ? 'x' : ' '}${close}${text}`,
  );
  return { body: lines.join('\n'), text: hit.text, changed: true };
}
