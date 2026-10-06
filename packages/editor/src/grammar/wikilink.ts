// [[Target]] and [[Target|shown text]] wiki links, as an mdast transform.
//
// CommonMark leaves `[[x]]` as literal text when no link definition
// matches, so the links are found inside text nodes after parsing and
// split out into `wikiLink` nodes. Each gets exact source offsets, which
// the live-preview decorations rely on. Wiki links cannot contain
// emphasis or nested brackets; that is deliberate, titles are plain.
import type { Root, Text } from 'mdast';
import type { Plugin } from 'unified';
import { SKIP, visit } from 'unist-util-visit';

export interface WikiLink {
  type: 'wikiLink';
  /** The note title linked to, trimmed. */
  target: string;
  /** The text after `|`, when given. */
  alias?: string;
  position?: Text['position'];
}

declare module 'mdast' {
  interface PhrasingContentMap {
    wikiLink: WikiLink;
  }
  interface RootContentMap {
    wikiLink: WikiLink;
  }
}

const WIKI_LINK = /\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/g;

/** The wiki links in a piece of plain text, with offsets into it. */
export function findWikiLinks(
  text: string,
): { start: number; end: number; target: string; alias?: string }[] {
  const found = [];
  for (const m of text.matchAll(WIKI_LINK)) {
    const target = m[1].trim();
    if (!target) continue;
    const alias = m[2]?.trim();
    found.push({
      start: m.index,
      end: m.index + m[0].length,
      target,
      ...(alias ? { alias } : {}),
    });
  }
  return found;
}

/** The remark plugin. `source` is needed to map offsets exactly. */
export const remarkWikiLinks: Plugin<[], Root> = function () {
  return (tree, file) => {
    const source = String(file.value ?? '');
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === undefined || !node.value.includes('[[')) return;
      const start = node.position?.start;
      const end = node.position?.end;
      if (!start || !end || start.offset === undefined || end.offset === undefined) return;
      // Offsets are only exact when the source spells the text literally
      // (no escapes or entities); otherwise leave the text alone.
      if (source.slice(start.offset, end.offset) !== node.value) return;

      const links = findWikiLinks(node.value);
      if (links.length === 0) return;

      const base = start.offset;
      const at = (offset: number) => pointAt(source, base + offset);
      const pieces: (Text | WikiLink)[] = [];
      let cursor = 0;
      for (const link of links) {
        if (link.start > cursor) {
          pieces.push({
            type: 'text',
            value: node.value.slice(cursor, link.start),
            position: { start: at(cursor), end: at(link.start) },
          });
        }
        pieces.push({
          type: 'wikiLink',
          target: link.target,
          ...(link.alias ? { alias: link.alias } : {}),
          position: { start: at(link.start), end: at(link.end) },
        });
        cursor = link.end;
      }
      if (cursor < node.value.length) {
        pieces.push({
          type: 'text',
          value: node.value.slice(cursor),
          position: { start: at(cursor), end: at(node.value.length) },
        });
      }
      parent.children.splice(index, 1, ...(pieces as typeof parent.children));
      return [SKIP, index + pieces.length];
    });
  };
};

/** A unist point (1-based line and column) for an offset in `source`. */
export function pointAt(source: string, offset: number) {
  let line = 1;
  let lineStart = 0;
  for (let i = source.indexOf('\n'); i !== -1 && i < offset; i = source.indexOf('\n', i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, column: offset - lineStart + 1, offset };
}
