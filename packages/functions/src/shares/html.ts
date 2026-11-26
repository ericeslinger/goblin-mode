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
 * this before the parse. The grammar's cost grows with the square of
 * nesting (review of #343: 100,000 nested quotes took 29 s).
 */
export const MAX_NESTING = 16;
export const MAX_INDENT = 64;
/**
 * The most markdown marks one block (lines between blank lines) may
 * hold before the body is shown as plain text: emphasis, link and image
 * marks in the tens of thousands made the grammar take seconds (review
 * of #343: `_a` 100,000 times, 10 s).
 */
export const MAX_MARKS_PER_BLOCK = 2_000;

const MARKS = /[*_[\]()!<>`~|\\]/g;
const CONTAINER = /^[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]?/;

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

/** Whether some block of `markdown` holds more marks than MAX_MARKS_PER_BLOCK. */
export function tooManyMarks(markdown: string): boolean {
  for (const block of markdown.split(/\n[ \t]*\n/)) {
    let n = 0;
    MARKS.lastIndex = 0;
    while (MARKS.exec(block)) if (++n > MAX_MARKS_PER_BLOCK) return true;
  }
  return false;
}

/** `markdown` with every line's nesting and indent bounded (boundLine). */
export function boundNesting(markdown: string): string {
  return markdown.split('\n').map(boundLine).join('\n');
}

/**
 * A note body as the public page's HTML: see the head of this file. A
 * body of a shape the grammar is slow on (tooManyMarks) is shown as its
 * plain text, escaped, in one preformatted block; it is never passed
 * through unescaped.
 */
export function shareBodyHtml(markdown: string): string {
  const bounded = boundNesting(markdown);
  if (tooManyMarks(bounded)) return `<pre class="plain">${escapeHtml(markdown)}</pre>\n`;
  const tree: Root = parseNote(bounded);
  return blocks(tree as { children: Node[] }, 0);
}
