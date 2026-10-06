// Turns a note's mdast into decoration specs: which lines get a style,
// which spans are styled, which markdown syntax is hidden, and which
// spans are drawn as widgets. Pure (no CodeMirror, no DOM) so it can be
// unit tested; live/extension.ts maps the specs onto CodeMirror.
//
// In source mode only styling applies. In live mode the syntax of a
// construct is hidden, and widgets replace it, unless the selection is
// on one of its lines: there it shows as typed, so it can be edited.
import type { Nodes, Root } from 'mdast';

export type Mode = 'live' | 'source';

export type DecorationSpec =
  | { kind: 'line'; from: number; className: string }
  | { kind: 'mark'; from: number; to: number; className: string }
  | { kind: 'hide'; from: number; to: number }
  | { kind: 'checkbox'; from: number; to: number; checked: boolean; toggleAt: number }
  | { kind: 'wikiLink'; from: number; to: number; target: string; alias?: string }
  | { kind: 'image'; from: number; to: number; url: string; alt: string };

const TASK_MARKER = /^([-*+]|\d+[.)])[ \t]+\[([ xX])\]/;

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
          className: `gm-h${node.depth}`,
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
        const cls = { strong: 'gm-strong', emphasis: 'gm-em', delete: 'gm-del' }[node.type];
        specs.push({ kind: 'mark', from, to, className: cls });
        if (live && !isActive(node)) hideAroundChildren(node);
        break;
      }
      case 'inlineCode': {
        specs.push({ kind: 'mark', from, to, className: 'gm-code' });
        if (live && !isActive(node)) {
          let n = 0;
          while (text[from + n] === '`') n++;
          hide(from, from + n);
          hide(to - n, to);
        }
        break;
      }
      case 'link': {
        specs.push({ kind: 'mark', from, to, className: 'gm-link' });
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
          specs.push({ kind: 'mark', from, to, className: 'gm-wikilink-source' });
        }
        return;
      }
      case 'image': {
        if (live && !isActive(node)) {
          specs.push({ kind: 'image', from, to, url: node.url, alt: node.alt ?? '' });
        } else {
          specs.push({ kind: 'mark', from, to, className: 'gm-image-source' });
        }
        return;
      }
      case 'listItem': {
        if (node.checked !== null && node.checked !== undefined) {
          const m = TASK_MARKER.exec(text.slice(from));
          if (m) {
            const boxEnd = from + m[0].length;
            const line = node.position.start.line;
            if (node.checked)
              specs.push({ kind: 'line', from: starts[line - 1], className: 'gm-done' });
            if (live && !activeLines.has(line)) {
              specs.push({
                kind: 'checkbox',
                from,
                to: boxEnd,
                checked: node.checked,
                toggleAt: boxEnd - 2,
              });
            }
          }
        }
        break;
      }
      case 'blockquote':
        eachLine(node, 'gm-quote');
        break;
      case 'code':
        eachLine(node, 'gm-codeblock');
        return;
      case 'thematicBreak':
        eachLine(node, 'gm-hr');
        return;
    }
    if ('children' in node) for (const child of node.children as Nodes[]) walk(child);
  };

  for (const child of root.children) walk(child);
  return specs;
}
