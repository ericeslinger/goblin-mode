// The public page's markdown, as HTML (2026-11-26; DESIGN.md, Sharing a
// public copy). The page is on the app's own origin and a body can hold
// text from the web (an imported recipe, the assistant's findings), so
// this writes the HTML itself from the parsed note, one fixed set of
// tags and attributes, and escapes every character of text it was
// given: nothing in a body is ever passed through as markup. It reads
// the app's one grammar (parseNote), so `*bold*` and `_italic_` mean
// what they mean in the editor.
//
// Tags: h1 to h6 (a body's headings start at h2: the title is the
// page's h1), p, ul, ol, li, label and input (a disabled checkbox,
// named by its item), blockquote,
// pre, code, em, strong, del, br, hr, a, table, thead, tbody, tr, th,
// td. Attributes: an `a`'s href (http, https or mailto only) and rel,
// an `ol`'s start, a checkbox's type, checked and disabled, a cell's
// align. Raw HTML is shown as its text; an image is its alt text, a
// link to it when it is on the web, since the page loads no images.
import type { Nodes, Root } from 'mdast';
import { type WikiLink, parseNote } from '@mossgoblin/editor/grammar';
import { escapeHtml } from '@mossgoblin/schema';

export { escapeHtml };

/** Nesting deeper than this is shown as its text, not as nested tags. */
export const MAX_DEPTH = 40;

/** A link's address, when it is one the page may link to: http, https or mailto. */
export function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  // Only absolute addresses: a relative one would lead into the app.
  if (!/^(https?:\/\/|mailto:)/i.test(trimmed)) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

const REL = 'noopener noreferrer nofollow';

type Node = Nodes | WikiLink;

/** The words of a node and everything under it, as text. */
/** The words of a node and everything under it, as text; a loop, so no depth is too deep. */
function words(root: Node): string {
  let out = '';
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    switch (node.type) {
      case 'text':
      case 'inlineCode':
      case 'code':
      case 'html':
        out += node.value;
        break;
      case 'wikiLink':
        out += node.alias ?? node.target;
        break;
      case 'image':
      case 'imageReference':
        out += node.alt ?? '';
        break;
      case 'break':
        out += '\n';
        break;
      default:
        if ('children' in node) stack.push(...[...(node.children as Node[])].reverse());
    }
  }
  return out;
}

function children(node: { children: Node[] }, depth: number): string {
  return node.children.map((c) => render(c, depth + 1)).join('');
}

/** A block container's children: raw HTML among them is a paragraph of its text. */
function blocks(node: { children: Node[] }, depth: number): string {
  return node.children
    .map((c) => (c.type === 'html' ? `<p>${escapeHtml(c.value)}</p>\n` : render(c, depth + 1)))
    .join('');
}

function link(href: string | undefined, inner: string): string {
  return href ? `<a href="${escapeHtml(href)}" rel="${REL}">${inner}</a>` : inner;
}

function render(node: Node, depth: number): string {
  if (depth > MAX_DEPTH) return escapeHtml(words(node));
  switch (node.type) {
    case 'root':
      return blocks(node, depth);
    case 'paragraph':
      return `<p>${children(node, depth)}</p>\n`;
    case 'heading': {
      // The title is the page's h1: a body's own headings sit under it.
      const level = Math.min(6, node.depth + 1);
      return `<h${level}>${children(node, depth)}</h${level}>\n`;
    }
    case 'thematicBreak':
      return '<hr>\n';
    case 'blockquote':
      return `<blockquote>\n${blocks(node, depth)}</blockquote>\n`;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start =
        node.ordered && typeof node.start === 'number' && node.start !== 1
          ? ` start="${Math.max(0, Math.min(1e9, Math.trunc(node.start)))}"`
          : '';
      const tasks = node.children.some((i) => typeof i.checked === 'boolean');
      return `<${tag}${start}${tasks ? ' class="tasks"' : ''}>\n${children(node, depth)}</${tag}>\n`;
    }
    case 'listItem': {
      // A tight item's paragraph is its line, with no <p> of its own.
      const inner = node.children
        .map((c) =>
          !node.spread && c.type === 'paragraph'
            ? children(c, depth + 1)
            : c.type === 'html'
              ? `<p>${escapeHtml(c.value)}</p>`
              : render(c as Node, depth + 1),
        )
        .join('');
      if (typeof node.checked === 'boolean') {
        // In a label, so the box is named by its item's words.
        const box = `<input type="checkbox" disabled${node.checked ? ' checked' : ''}>`;
        return `<li class="task"><label>${box} ${inner}</label></li>\n`;
      }
      return `<li>${inner}</li>\n`;
    }
    case 'code':
      return `<pre><code>${escapeHtml(node.value)}</code></pre>\n`;
    case 'html':
      // Raw HTML is shown as what it says, never as markup.
      return escapeHtml(node.value);
    case 'text':
      // A note is written in lines: a line break inside a paragraph is
      // kept as one, as the editor shows it.
      return escapeHtml(node.value).replace(/\n/g, '<br>\n');
    case 'emphasis':
      return `<em>${children(node, depth)}</em>`;
    case 'strong':
      return `<strong>${children(node, depth)}</strong>`;
    case 'delete':
      return `<del>${children(node, depth)}</del>`;
    case 'inlineCode':
      return `<code>${escapeHtml(node.value)}</code>`;
    case 'break':
      return '<br>\n';
    case 'link':
      return link(safeHref(node.url), children(node, depth));
    case 'image': {
      // No images load on the page; a web image is a link with its alt text.
      const alt = escapeHtml(node.alt || 'image');
      return link(safeHref(node.url), alt);
    }
    case 'wikiLink':
      return escapeHtml(node.alias ?? node.target);
    case 'table': {
      const [head, ...rows] = node.children;
      const align = node.align ?? [];
      const cells = (row: typeof head, tag: 'th' | 'td') =>
        row.children
          .map((cell, i) => {
            const a = align[i];
            const attr = a === 'left' || a === 'right' || a === 'center' ? ` align="${a}"` : '';
            return `<${tag}${attr}>${children(cell, depth + 2)}</${tag}>`;
          })
          .join('');
      const body = rows.map((r) => `<tr>${cells(r, 'td')}</tr>\n`).join('');
      return (
        `<table>\n<thead>\n<tr>${head ? cells(head, 'th') : ''}</tr>\n</thead>\n` +
        (body ? `<tbody>\n${body}</tbody>\n` : '') +
        '</table>\n'
      );
    }
    // A reference to a definition is shown as its words; definitions,
    // footnotes and anything else this does not know, as their text.
    case 'definition':
      return '';
    default:
      return 'children' in node
        ? children(node as { children: Node[] }, depth)
        : escapeHtml(words(node));
  }
}

/**
 * The most container markers (quotes, list items) a line may open, and
 * the most columns of leading space it may have: deeper is flattened to
 * this before the parse (review of #343: 100,000 nested quotes took
 * 29 s). Inside fenced code nothing is changed.
 */
export const MAX_NESTING = 16;
export const MAX_INDENT = 64;

/**
 * The body is parsed in stretches of about this many lines (or
 * characters), cut where markdown starts afresh anyway (after a blank
 * line, or before a line that opens a top-level list item or quote),
 * or at twice that before any line at the margin but a table's, never
 * inside fenced code, because the grammar's cost on nested lists grows with the
 * square of the lines it reads at once (review of #343: 8,000 lines of
 * 16 nested markers, 32.8 s). A note shorter than this is parsed whole,
 * as before. Cut, a long list becomes several lists, numbered on.
 */
export const STRETCH_LINES = 60;
export const STRETCH_CHARS = 6_000;

/**
 * A stretch past either budget is shown as its plain text, escaped, in
 * a preformatted block of its own; the rest of the body keeps its
 * formatting. Marks: emphasis, link, image, code and HTML characters,
 * after each line's list or checkbox opening (`_a` 100,000 times took
 * 10 s). Nesting work: its lines times the extra container markers on
 * them (a stretch of 600 lines with 15 extra each took 0.7 s). Table
 * cells, below.
 */
export const MAX_MARKS = 2_000;
export const MAX_NESTING_WORK = 400_000;
/**
 * The most extra container markers the whole body may parse: past this,
 * a nested stretch is plain (16 nested markers on each of 5,400 lines
 * took about 2 s within the other limits).
 */
export const MAX_BODY_NESTING = 10_000;
/**
 * The most lines the whole body may parse; past this the rest is plain
 * (66,000 short lines of text and rules took about 1.5 s, by the number
 * of nodes; a note of 200,000 characters seldom has a fifth as many).
 */
export const MAX_BODY_LINES = 20_000;
/** The most table cells (`|`) a stretch may hold: a 500-column table of 200 rows took 2 s. */
export const MAX_CELLS = 20_000;

const MARKS = /[*_[\]()!<>`~\\]/g;
const CONTAINER = /^[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]?/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that starts a top-level list item or quote: markdown starts afresh there. */
const TOP_LEVEL = /^(?:>|[-*+][ \t]|\d{1,9}[.)][ \t])/;

/** `line` with no more than MAX_NESTING containers opened and MAX_INDENT columns of indent. */
function boundLine(line: string): string {
  let rest = line;
  let prefix = '';
  for (let n = 0; n < MAX_NESTING; n++) {
    const m = CONTAINER.exec(rest);
    if (!m) break;
    prefix += m[0];
    rest = rest.slice(m[0].length);
  }
  // Past the cap, further markers are dropped, and so is deep indent.
  while (CONTAINER.test(rest)) rest = rest.replace(CONTAINER, '');
  const indent = /^[ \t]*/.exec(prefix + rest)![0];
  if (indent.length > MAX_INDENT)
    return ' '.repeat(MAX_INDENT) + (prefix + rest).slice(indent.length);
  return prefix + rest;
}

/** A line's container markers, and what follows them (its checkbox too). */
function opening(line: string): { markers: number; rest: string } {
  let rest = line;
  let markers = 0;
  for (let m = CONTAINER.exec(rest); m; m = CONTAINER.exec(rest)) {
    markers++;
    rest = rest.slice(m[0].length);
  }
  return { markers, rest: rest.replace(/^\[[ xX]\][ \t]/, '') };
}

/** Whether `lines` would cost the grammar more than the budgets allow. */
/** The extra container markers on `lines` (each line's beyond its first), outside fenced code. */
export function nestingOf(lines: readonly string[]): number {
  let extra = 0;
  let fence: string | undefined;
  for (const line of lines) {
    const mark = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    extra += Math.max(0, opening(line).markers - 1);
  }
  return extra;
}

export function tooCostly(lines: readonly string[]): boolean {
  let marks = 0;
  let extra = 0;
  let cells = 0;
  let fence: string | undefined;
  for (const line of lines) {
    // Fenced code is read as it is, with no marks in it.
    const mark = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    const { markers, rest } = opening(line);
    extra += Math.max(0, markers - 1);
    for (let i = rest.indexOf('|'); i !== -1; i = rest.indexOf('|', i + 1)) {
      if (++cells > MAX_CELLS) return true;
    }
    MARKS.lastIndex = 0;
    while (MARKS.exec(rest)) if (++marks > MAX_MARKS) return true;
  }
  return lines.length * extra > MAX_NESTING_WORK;
}

/** A stretch of the body, to parse as markdown or to show as plain text. */
export interface Stretch {
  lines: string[];
  plain: boolean;
}

/**
 * The body bounded (boundLine, outside fenced code) and cut into
 * stretches (STRETCH_LINES), each judged against the budgets.
 */
export function stretches(markdown: string): Stretch[] {
  const out: Stretch[] = [];
  let current: string[] = [];
  let chars = 0;
  let fence: string | undefined;
  let blankBefore = false;
  let nesting = 0;
  let parsed = 0;
  const flush = () => {
    if (current.length) {
      const extra = nestingOf(current);
      if (parsed + current.length > MAX_BODY_LINES) {
        out.push({ lines: current, plain: true });
      } else if (extra && nesting + extra > MAX_BODY_NESTING) {
        out.push({ lines: current, plain: true });
      } else if (tooCostly(current)) {
        out.push(...byBlock(current));
      } else {
        nesting += extra;
        parsed += current.length;
        out.push({ lines: current, plain: false });
      }
    }
    current = [];
    chars = 0;
  };
  for (const raw of markdown.split('\n')) {
    const fenceMark = FENCE.exec(raw)?.[1];
    const inFence = fence !== undefined;
    const big = current.length >= STRETCH_LINES || chars >= STRETCH_CHARS;
    // Twice that with no fresh start: any line at the margin will do,
    // but a table's row, which would lose its header (a paragraph cut
    // there becomes two, a lazy line a paragraph of its own).
    const huge = current.length >= 2 * STRETCH_LINES || chars >= 2 * STRETCH_CHARS;
    const fresh = blankBefore || TOP_LEVEL.test(raw);
    if (!inFence && ((big && fresh) || (huge && /^[^\s|]/.test(raw)))) flush();
    const line = inFence ? raw : boundLine(raw);
    current.push(line);
    chars += line.length + 1;
    if (inFence) {
      if (fenceMark && fenceMark[0] === fence![0] && fenceMark.length >= fence!.length) {
        fence = undefined;
      }
    } else if (fenceMark) {
      fence = fenceMark;
    }
    blankBefore = !inFence && !raw.trim();
  }
  flush();
  return out;
}

/**
 * A costly stretch cut at its blank lines (outside fenced code) into
 * blocks, each judged on its own: only a costly block is plain, and
 * the cheap ones around it, together, are markdown.
 */
function byBlock(lines: readonly string[]): Stretch[] {
  const blocks: string[][] = [];
  let block: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    block.push(line);
    const mark = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
    } else if (mark) {
      fence = mark;
    } else if (!line.trim()) {
      blocks.push(block);
      block = [];
    }
  }
  if (block.length) blocks.push(block);
  const out: Stretch[] = [];
  for (const b of blocks) {
    const plain = tooCostly(b);
    const last = out[out.length - 1];
    if (last && last.plain === plain && !plain) last.lines.push(...b);
    else out.push({ lines: [...b], plain });
  }
  return out;
}

/**
 * A note body as the public page's HTML: see the head of this file. A
 * stretch of a shape the grammar is slow on (`tooCostly`) is shown as
 * its plain text, escaped, in a preformatted block of its own; it is
 * never passed through unescaped, and the rest keeps its formatting.
 */
export function shareBodyHtml(markdown: string): string {
  return stretches(markdown)
    .map((s) => {
      const text = s.lines.join('\n');
      if (s.plain) return `<pre class="plain">${escapeHtml(text)}</pre>\n`;
      const tree: Root = parseNote(text);
      return blocks(tree as { children: Node[] }, 0);
    })
    .join('');
}
