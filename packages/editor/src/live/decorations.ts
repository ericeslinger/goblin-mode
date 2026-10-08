// Turns a note's mdast into decoration specs: which lines get a style,
// which spans are styled, which markdown syntax is hidden, and which
// spans are drawn as widgets. Pure (no CodeMirror, no DOM) so it can be
// unit tested; live/extension.ts maps the specs onto CodeMirror.
//
// In source mode only styling applies. In live mode the syntax of a
// construct is hidden, and widgets replace it, unless the selection is
// on one of its lines: there it shows as typed, so it can be edited.
import type { Nodes, Root } from 'mdast';
import { ATTACHMENT_SCHEME } from '../grammar/extract';

export type Mode = 'live' | 'source';

export type DecorationSpec =
  | { kind: 'line'; from: number; className: string }
  | { kind: 'mark'; from: number; to: number; className: string }
  | { kind: 'hide'; from: number; to: number }
  | { kind: 'checkbox'; from: number; to: number; checked: boolean; toggleAt: number }
  | { kind: 'bullet'; from: number; to: number }
  | { kind: 'wikiLink'; from: number; to: number; target: string; alias?: string }
  | { kind: 'image'; from: number; to: number; url: string; alt: string }
  | { kind: 'file'; from: number; to: number; id: string; name: string };

const TASK_MARKER = /^([-*+]|\d+[.)])[ \t]+\[([ xX])\]/;
const LIST_MARKER = /^([-*+]|\d+[.)])/;

type Positioned = Nodes & {
  position: { start: { line: number; offset: number }; end: { line: number; offset: number } };
};

function positioned(node: Nodes): node is Positioned {
  return node.position?.start.offset !== undefined && node.position?.end.offset !== undefined;
}

/** Offsets of the start of each line (index 0 is line 1). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

export function computeDecorations(
  text: string,
  root: Root,
  mode: Mode,
  activeLines: ReadonlySet<number>,
): DecorationSpec[] {
  const specs: DecorationSpec[] = [];
  const starts = lineStarts(text);
  const live = mode === 'live';

  const isActive = (node: Positioned) => {
    for (let l = node.position.start.line; l <= node.position.end.line; l++) {
      if (activeLines.has(l)) return true;
    }
    return false;
  };
  const eachLine = (node: Positioned, className: string) => {
    for (let l = node.position.start.line; l <= node.position.end.line; l++) {
      specs.push({ kind: 'line', from: starts[l - 1], className });
    }
  };
  const hide = (from: number, to: number) => {
    if (to > from) specs.push({ kind: 'hide', from, to });
  };
  /** Hides the delimiters around a node's children (`**`, `_`, `[`…). */
  const hideAroundChildren = (node: Positioned) => {
    const kids = 'children' in node ? (node.children as Nodes[]).filter(positioned) : [];
    if (kids.length === 0) return;
    hide(node.position.start.offset, kids[0].position.start.offset);
    hide(kids[kids.length - 1].position.end.offset, node.position.end.offset);
  };

  const walk = (node: Nodes) => {
    if (!positioned(node)) return;
    const from = node.position.start.offset;
    const to = node.position.end.offset;

    switch (node.type) {
      case 'heading': {
        specs.push({
          kind: 'line',
          from: starts[node.position.start.line - 1],
          className: `mg-h${node.depth}`,
        });
        if (live && !isActive(node) && text[from] === '#') {
          const first = (node.children as Nodes[]).find(positioned);
          hide(from, first ? first.position.start.offset : to);
        }
        break;
      }
      case 'strong':
      case 'emphasis':
      case 'delete': {
        const cls = { strong: 'mg-strong', emphasis: 'mg-em', delete: 'mg-del' }[node.type];
        specs.push({ kind: 'mark', from, to, className: cls });
        if (live && !isActive(node)) hideAroundChildren(node);
        break;
      }
      case 'inlineCode': {
        specs.push({ kind: 'mark', from, to, className: 'mg-code' });
        if (live && !isActive(node)) {
          let n = 0;
          while (text[from + n] === '`') n++;
          hide(from, from + n);
          hide(to - n, to);
        }
        break;
      }
      case 'link': {
        // A file kept in the garden (#45): a chip that opens it.
        if (node.url.startsWith(ATTACHMENT_SCHEME) && live && !isActive(node)) {
          const name = node.children.map((c) => ('value' in c ? c.value : '')).join('');
          specs.push({
            kind: 'file',
            from,
            to,
            id: node.url.slice(ATTACHMENT_SCHEME.length),
            name,
          });
          return;
        }
        specs.push({ kind: 'mark', from, to, className: 'mg-link' });
        // Only bracketed links have syntax to hide; autolinks do not.
        if (live && !isActive(node) && text[from] === '[') hideAroundChildren(node);
        break;
      }
      case 'wikiLink': {
        if (live && !isActive(node)) {
          specs.push({
            kind: 'wikiLink',
            from,
            to,
            target: node.target,
            ...(node.alias ? { alias: node.alias } : {}),
          });
        } else {
          specs.push({ kind: 'mark', from, to, className: 'mg-wikilink-source' });
        }
        return;
      }
      case 'image': {
        if (live && !isActive(node)) {
          specs.push({ kind: 'image', from, to, url: node.url, alt: node.alt ?? '' });
        } else {
          specs.push({ kind: 'mark', from, to, className: 'mg-image-source' });
        }
        return;
      }
      case 'listItem': {
        const line = node.position.start.line;
        const editing = activeLines.has(line);
        const task = node.checked != null ? TASK_MARKER.exec(text.slice(from)) : null;
        if (task) {
          const boxEnd = from + task[0].length;
          if (node.checked)
            specs.push({ kind: 'line', from: starts[line - 1], className: 'mg-done' });
          if (live && !editing) {
            specs.push({
              kind: 'checkbox',
              from,
              to: boxEnd,
              checked: node.checked === true,
              toggleAt: boxEnd - 2,
            });
          }
        } else {
          const marker = LIST_MARKER.exec(text.slice(from));
          if (marker) {
            const markerEnd = from + marker[1].length;
            if (/^\d/.test(marker[1])) {
              specs.push({ kind: 'mark', from, to: markerEnd, className: 'mg-list-number' });
            } else if (live && !editing) {
              specs.push({ kind: 'bullet', from, to: markerEnd });
            } else {
              specs.push({ kind: 'mark', from, to: markerEnd, className: 'mg-list-marker' });
            }
          }
        }
        break;
      }
      case 'blockquote':
        eachLine(node, 'mg-quote');
        break;
      case 'code':
        eachLine(node, 'mg-codeblock');
        return;
      case 'thematicBreak':
        eachLine(node, 'mg-hr');
        return;
    }
    if ('children' in node) for (const child of node.children as Nodes[]) walk(child);
  };

  for (const child of root.children) walk(child);
  return specs;
}
