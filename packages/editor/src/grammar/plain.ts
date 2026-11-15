// The plain words of a note, for anywhere a line of it is shown as text
// rather than rendered: Browse's snippets, the notes list, a meal slot
// (#285, 2026-11-15). It reads the one grammar (parseNote), so it agrees
// with the editor on what is a mark and what is a word: `snake_case`,
// `2 * 3` and a lone star stay as typed. Display only: what it returns
// is never written back.
import type { Nodes, Root } from 'mdast';
import { parseNote } from './parse';
import type { WikiLink } from './wikilink';

/** Blocks whose words make one line (or several, at their line breaks). */
const LINE_BLOCKS = new Set(['paragraph', 'heading']);

/** The words of inline content: marks dropped, links as their text. */
function words(node: Nodes | WikiLink): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value;
    case 'wikiLink':
      return node.alias ?? node.target;
    // An image is its alt text, never its address.
    case 'image':
    case 'imageReference':
      return node.alt ?? '';
    case 'break':
      return '\n';
    // Raw HTML is markup, not words.
    case 'html':
    case 'footnoteReference':
      return '';
    default:
      return 'children' in node ? (node.children as Nodes[]).map(words).join('') : '';
  }
}

function lines(node: Nodes | Root, out: string[]): void {
  if (node.type === 'code') {
    out.push(...node.value.split('\n'));
    return;
  }
  if (node.type === 'tableRow') {
    out.push(node.children.map(words).join(' '));
    return;
  }
  if (LINE_BLOCKS.has(node.type)) {
    out.push(...words(node).split('\n'));
    return;
  }
  // Raw HTML blocks, definitions and rules hold no words to show.
  if (node.type === 'html' || node.type === 'definition' || node.type === 'thematicBreak') return;
  if ('children' in node) for (const child of node.children as Nodes[]) lines(child, out);
}

/**
 * The plain words of markdown in this app's dialect, a line per line of
 * text, empty lines left out: `[[name]]` and `[[name|label]]` are the
 * name or label, `[text](url)` is its text, `![alt](url)` its alt text
 * (nothing when that is empty), emphasis, code ticks, heading, quote
 * and list or checkbox markers are dropped. A bare address stays as it
 * is, as does a `#tag`.
 */
export function plainText(markdown: string): string {
  if (!markdown.trim()) return '';
  const out: string[] = [];
  lines(parseNote(markdown), out);
  return out
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}
