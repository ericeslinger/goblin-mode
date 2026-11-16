// A small reading of HTML as a tree of elements, for reader mode
// (2026-11-16): one linear pass over the tags, so a nested element is
// found whole (a lazy regex ends a <div> at the first </div>). Not a
// browser: void elements and comments are skipped, script and style
// bodies are not read for tags, a close tag closes what was left open
// inside its element, and a stray close is ignored. Positions are
// offsets into the string read, so callers cut and splice the source.
import { decode } from '../attachments/import';

/** Elements that never hold others. */
export const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Elements whose bodies are text, never tags. */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'template', 'xmp']);

/** Elements a new <p> or a block closes, as a browser does. */
const CLOSED_BY_BLOCK = new Set(['p']);
const BLOCKS = new Set([
  'p',
  'div',
  'ul',
  'ol',
  'table',
  'pre',
  'blockquote',
  'section',
  'article',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'footer',
  'aside',
  'nav',
  'main',
  'form',
  'hr',
  'dl',
]);

export interface El {
  /** Lowercased tag name; '#root' for the whole string. */
  name: string;
  /** The start tag as written. */
  tag: string;
  /** Where the start tag begins. */
  start: number;
  /** Where the start tag ends: the element's inside begins here. */
  innerStart: number;
  /** Where the inside ends: its close tag, or where it was closed. */
  innerEnd: number;
  /** Where the element ends, close tag included. */
  end: number;
  parent?: El;
  children: El[];
  depth: number;
}

/** A tag, a `>` inside a quoted attribute value not ending it. */
const TAG =
  /<(\/?)([a-z][a-z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!--[\s\S]*?(?:-->|$)|<![^>]*>/gi;

/** The elements of `html` as a tree under a root that spans it all. */
export function parseTree(html: string): El {
  const root: El = {
    name: '#root',
    tag: '',
    start: 0,
    innerStart: 0,
    innerEnd: html.length,
    end: html.length,
    children: [],
    depth: 0,
  };
  const stack: El[] = [root];
  // Closes stack[i] at `at`, its own close tag ending at `end`, and
  // everything left open inside it where that close tag begins.
  const closeTo = (i: number, at: number, end: number) => {
    while (stack.length > i) {
      const el = stack.pop()!;
      el.innerEnd = at;
      el.end = stack.length === i ? end : at;
    }
  };
  TAG.lastIndex = 0;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    const [whole, close, rawName, , selfClose] = m;
    if (!rawName) continue; // a comment or a doctype
    const name = rawName.toLowerCase();
    const at = m.index;
    if (close) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          closeTo(i, at, at + whole.length);
          break;
        }
      }
      continue;
    }
    const top = stack[stack.length - 1];
    if (BLOCKS.has(name) && CLOSED_BY_BLOCK.has(top.name)) closeTo(stack.length - 1, at, at);
    if (name === 'li') {
      // A new item closes the one before it in the same list.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === 'ul' || stack[i].name === 'ol') break;
        if (stack[i].name === 'li') {
          closeTo(i, at, at);
          break;
        }
      }
    }
    const parent = stack[stack.length - 1];
    const el: El = {
      name,
      tag: whole,
      start: at,
      innerStart: at + whole.length,
      innerEnd: at + whole.length,
      end: at + whole.length,
      parent,
      children: [],
      depth: parent.depth + 1,
    };
    parent.children.push(el);
    if (VOID.has(name) || selfClose) continue;
    if (RAW.has(name)) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'gi');
      closeRe.lastIndex = el.innerStart;
      const c = closeRe.exec(html);
      el.innerEnd = c ? c.index : html.length;
      el.end = c ? c.index + c[0].length : html.length;
      TAG.lastIndex = el.end;
      continue;
    }
    stack.push(el);
  }
  closeTo(1, html.length, html.length);
  return root;
}

/** How many elements `html` holds and how deep they nest: one pass, no tree kept. */
export function measure(html: string): { elements: number; depth: number } {
  let elements = 0;
  let depth = 0;
  const open: string[] = [];
  TAG.lastIndex = 0;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    const [whole, close, rawName, , selfClose] = m;
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    if (close) {
      const i = open.lastIndexOf(name);
      if (i >= 0) open.length = i;
      continue;
    }
    elements++;
    if (VOID.has(name) || selfClose) continue;
    if (RAW.has(name)) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'gi');
      closeRe.lastIndex = m.index + whole.length;
      const c = closeRe.exec(html);
      TAG.lastIndex = c ? c.index + c[0].length : html.length;
      continue;
    }
    // A <p> left open is closed by the next one, so it does not deepen.
    if (name === 'p' && open[open.length - 1] === 'p') open.pop();
    open.push(name);
    depth = Math.max(depth, open.length);
  }
  return { elements, depth };
}

/**
 * Every element under `el`, in document order, `el` not included. A
 * loop, not recursion: a page can nest deeper than the stack goes.
 */
export function descendants(el: El): El[] {
  const out: El[] = [];
  const stack = [...el.children].reverse();
  while (stack.length) {
    const next = stack.pop()!;
    out.push(next);
    for (let i = next.children.length - 1; i >= 0; i--) stack.push(next.children[i]);
  }
  return out;
}

/**
 * Walks the elements under `root` from the top; `visit` says whether to
 * go on into an element's children. A loop, as `descendants` is.
 */
export function walk(root: El, visit: (el: El) => boolean): void {
  const stack = [...root.children].reverse();
  while (stack.length) {
    const el = stack.pop()!;
    if (visit(el)) for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
  }
}

/** The element's HTML, tags included. */
export const outerHtml = (html: string, el: El) => html.slice(el.start, el.end);
/** The element's HTML inside its tags. */
export const innerHtml = (html: string, el: El) => html.slice(el.innerStart, el.innerEnd);

/** A start tag's attribute, decoded and trimmed; '' when it has none. */
export function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return decode(m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}

/** Whether a start tag has the attribute at all. */
export const hasAttr = (tag: string, name: string) =>
  new RegExp(`\\s${name}(?:\\s*=|[\\s/>])`, 'i').test(tag);

/** The words of some HTML: tags out, entities read, spaces collapsed. */
export function textOf(html: string): string {
  return decode(
    html
      .replace(/<(script|style|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
      .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * `html` with the edits made, in order of position. An edit inside
 * another is skipped, so a dropped block goes whole with whatever
 * smaller change was asked inside it.
 */
export function applyEdits(html: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let at = 0;
  for (const e of sorted) {
    if (e.start < at) continue;
    out += html.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + html.slice(at);
}
