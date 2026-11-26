// The body of a note's public copy (2026-11-26, Eric; DESIGN.md, Sharing
// a public copy): the note's own markdown with the app's machinery taken
// out, so what is stored for anyone with the link to read is the text
// and nothing that only means something inside Mossgoblin. It reads the
// one grammar (parseNote), so it agrees with the editor on what a wiki
// link or an image is; everything else stays as Eric wrote it.
//
// What it does, by what a body can hold:
// - `[[name]]` and `[[name|label]]`: the name or the label, as words
//   (a mark in them escaped, so `[[a*b]]` stays `a*b`).
// - `#tag`: stays, as the words it is.
// - checkbox lines: stay; the public page shows them read-only.
// - `@goblin` at the end of a checkbox item (the assistant's): dropped,
//   the item kept.
// - `✳ Mossgoblin:` lines (why the assistant could not do an item):
//   dropped. Its findings (`✳ Mossgoblin, from the web:` and the lines
//   under it) are kept, as plain words, as the note shows them.
// - images of attachments (`attachment:`): dropped; media is part 2.
// - everything else (links, emphasis, headings, code, raw HTML): as
//   written; the public page escapes it and renders a fixed set of tags.
import type { Nodes, Root } from 'mdast';
import { ATTACHMENT_SCHEME } from './extract';
import { parseNote } from './parse';
import type { WikiLink } from './wikilink';

/** As assigned.ts in the schema: a checkbox item, and the mention at its end. */
const TASK = /^(\s*[-*+]\s+\[[ xX]\]\s+)(.*\S)(\s*)$/;
const MENTION = /\s*@goblin\s*$/i;
/** As STATUS_MARK in the schema's assigned.ts. */
const STATUS_LINE = /^\s*[-*+]\s+✳ Mossgoblin:(?!.*from the web:)/;

/** Words that may hold markdown's marks, written so they stay words. */
function asWords(text: string): string {
  return text.replace(/[\\`*_[\]<>!#|~]/g, (c) => `\\${c}`);
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * The edits for every wiki link and attached image under `root`. A loop
 * over a stack rather than recursion, so no nesting is too deep for it
 * (review of #343: 5,000 nested quotes overflowed the call stack).
 */
function collect(root: Root, edits: Edit[]): void {
  const stack: (Nodes | WikiLink | Root)[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === 'wikiLink') {
      if (start !== undefined && end !== undefined) {
        edits.push({ start, end, text: asWords(node.alias ?? node.target) });
      }
      continue;
    }
    if (node.type === 'image' && node.url.startsWith(ATTACHMENT_SCHEME)) {
      if (start !== undefined && end !== undefined) edits.push({ start, end, text: '' });
      continue;
    }
    // Code keeps its text exactly, `[[x]]` included.
    if (node.type === 'code' || node.type === 'inlineCode') continue;
    if ('children' in node) stack.push(...(node.children as Nodes[]));
  }
}

/** The body of a public copy of `body`; see the head of this file. */
export function publicCopy(body: string): string {
  const edits: Edit[] = [];
  collect(parseNote(body), edits);
  let out = body;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out
    .split('\n')
    .filter((line) => !STATUS_LINE.test(line))
    .map((line) => {
      const m = TASK.exec(line);
      if (!m || !MENTION.test(m[2])) return line;
      return `${m[1]}${m[2].replace(MENTION, '')}${m[3]}`;
    })
    .join('\n');
}
