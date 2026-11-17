// An article's HTML as the app's markdown (#161): headings, paragraphs,
// lists, quotes, code, links and images, everything else to words.
// Hidden elements go first (visibleHtml, CLAUDE.md: page text), then the
// structure is kept as the notes grammar writes it: *bold*, _italic_.
// Pure over text; the fetcher caps and stores the result on the item.
import { escapeMarkdown } from '@mossgoblin/schema';
import { decode, visibleHtml } from '../attachments/import';
import { escapeStrayLt, tagsOf } from '../attachments/tag-scan';
import { type El, type Edit, applyEdits, attr, parseTree, walk } from './html-tree';

/** The most of an article's content kept, in characters. */
export const CONTENT_MAX = 20_000;
/** The first lines shown in the compact list, in characters. */
export const SUMMARY_MAX = 300;

/** Elements whose contents are never words for a reader. */
const DROP =
  /<(script|style|noscript|svg|math|iframe|object|embed|form|button|input|select|textarea|video|audio|canvas|map|head)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

const inner = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');

/**
 * Code with its highlighter's buttons as plain spans (2026-11-16): a
 * hover hint wraps a word of the code in a <button> (Node's blog), and
 * buttons are dropped as controls, which took the code's words with
 * them.
 */
export function codeButtonsAsSpans(html: string): string {
  return html.replace(/<pre\b[\s\S]*?(?:<\/pre\s*>|$)/gi, (pre) =>
    pre.replace(/<(\/?)button\b/gi, '<$1span'),
  );
}

/**
 * Where the converter pads what it marks (a link, *bold*, _italic_, an
 * image) it writes this, not a space (2026-11-16); `settle` makes it a
 * space only between words, so a mark is never cut off from the comma
 * after it ("[strip](…) ;", "_Ocarina of Time_ ‘s").
 */
const SOFT = '\u0001';
const soft = (text: string) => `${SOFT}${text}${SOFT}`;

/** Soft spaces made real between words, and dropped elsewhere. */
function settle(text: string): string {
  return text.replace(/\u0001+/g, (_, at: number, all: string) => {
    const before = all[at - 1] ?? ' ';
    const after = all[at + _.length] ?? ' ';
    if (/\s/.test(before) || /\s/.test(after)) return '';
    if (/[.,;:!?)\]}’”…%'"‘]/.test(after)) return '';
    if (/[([{‘“]/.test(before)) return '';
    return ' ';
  });
}

/** A link a note may carry: http(s), absolute. */
function webLink(href: string, base: string): string | undefined {
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The elements whose patterns below run lazily from the open tag to the close. */
const PAIRED = new Set([
  'pre',
  'code',
  'b',
  'strong',
  'i',
  'em',
  'cite',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ol',
  'blockquote',
]);

/** `html` without the open tags of PAIRED elements no close follows. */
function unclosedOpensDropped(html: string): string {
  const tags = [...tagsOf(html)];
  const lastClose = new Map<string, number>();
  for (const t of tags) if (t.close) lastClose.set(t.name.toLowerCase(), t.start);
  let out = '';
  let at = 0;
  for (const t of tags) {
    const name = t.name.toLowerCase();
    if (t.close || !PAIRED.has(name) || t.start < (lastClose.get(name) ?? -1)) continue;
    out += `${html.slice(at, t.start)} `;
    at = t.end;
  }
  return out + html.slice(at);
}

/**
 * The text between tags escaped; tags and placeholders left as they
 * are. A `<` the text decodes to is held as LT until the end, so the
 * patterns that follow, which look for tags, never read the page's
 * words as one (review, 2026-11-16: "&lt;a " repeated was read as tags
 * left open, and slowly).
 */
function escapeText(html: string): string {
  return html
    .split(/(<[^>]+>|\u0000\d+\u0000)/)
    .map((part, i) => (i % 2 ? part : escapeMarkdown(decode(part)).replace(/</g, LT)))
    .join('');
}

/** Stands for a `<` in the page's words while tags are still being read. */
const LT = '\u0002';

/** The most columns a table is written as a table with; a wider one is its words. */
export const TABLE_COLUMNS = 12;
/** A cell holding more words than this is a page's layout, not data. */
const CELL_MAX = 400;
/** Elements a data table's cells never hold: a table holding one lays out a page. */
const CELL_BLOCKS = new Set([
  'table',
  'ul',
  'ol',
  'li',
  'dl',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'hr',
  'figure',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'main',
  'nav',
  'details',
]);

interface Cell {
  from: number;
  to: number;
  th: boolean;
  colspan: number;
  rowspan: number;
}

/**
 * A table as a pipe table (#313, 2026-11-17), or undefined when it is
 * no data table: one marked as presentation, holding a table or a
 * block (a list, a heading, a quote, code), a cell over CELL_MAX
 * characters, fewer than two rows or columns, or more than
 * TABLE_COLUMNS. `s` is the converter's text with inline marks done;
 * `words` makes a stretch of it a cell's settled words. The rows are
 * read flat, a cell running to the next cell or row however the page
 * left its tags open, so each is read once.
 */
function pipeTable(s: string, table: El, words: (html: string) => string): string | undefined {
  if (/^(?:presentation|none)$/i.test(attr(table.tag, 'role'))) return undefined;
  const rows: { head: boolean; foot: boolean; cells: Cell[] }[] = [];
  let caption: El | undefined;
  // The row group the reading is in, while it is inside it.
  let group: El | undefined;
  const inGroup = (el: El, name: string) => group?.name === name && el.start < group.end;
  let last: Cell | undefined;
  const end = (at: number) => {
    if (last) last.to = Math.min(last.to, at);
    last = undefined;
  };
  // The table's elements in order, stopping at the first that makes it
  // layout: each element is read by the innermost table holding it.
  const stack = [...table.children].reverse();
  while (stack.length) {
    const el = stack.pop()!;
    if (CELL_BLOCKS.has(el.name)) return undefined;
    if (el.name === 'thead' || el.name === 'tbody' || el.name === 'tfoot') group = el;
    if (el.name === 'caption') {
      end(el.start);
      caption ??= el;
      continue;
    }
    if (el.name === 'tr') {
      end(el.start);
      rows.push({ head: inGroup(el, 'thead'), foot: inGroup(el, 'tfoot'), cells: [] });
    } else if (el.name === 'td' || el.name === 'th') {
      end(el.start);
      if (!rows.length) rows.push({ head: inGroup(el, 'thead'), foot: false, cells: [] });
      const span = (name: string, most: number) =>
        Math.min(most, Math.max(1, Math.floor(Number(attr(el.tag, name))) || 1));
      last = {
        from: el.innerStart,
        to: el.innerEnd,
        th: el.name === 'th',
        colspan: span('colspan', TABLE_COLUMNS),
        rowspan: span('rowspan', 1000),
      };
      rows[rows.length - 1].cells.push(last);
    }
    for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
  }
  // The header first and the footer last, as a browser draws them.
  const ordered = [
    ...rows.filter((r) => r.head),
    ...rows.filter((r) => !r.head && !r.foot),
    ...rows.filter((r) => r.foot && !r.head),
  ].filter((r) => r.cells.length);
  if (ordered.length < 2) return undefined;
  // The grid: a spanned cell's words once, the places it spans empty.
  const grid: { text: string; th: boolean }[][] = [];
  const carry: number[] = [];
  for (const row of ordered) {
    const out: { text: string; th: boolean }[] = [];
    let col = 0;
    const skipSpanned = () => {
      while (carry[col] > 0) {
        carry[col]--;
        out.push({ text: '', th: false });
        col++;
      }
    };
    for (const cell of row.cells) {
      skipSpanned();
      const text = words(s.slice(cell.from, Math.max(cell.from, cell.to)));
      if (text.length > CELL_MAX || text.includes('\n')) return undefined;
      for (let k = 0; k < cell.colspan; k++) {
        out.push({ text: k ? '' : text, th: cell.th });
        if (cell.rowspan > 1) carry[col] = cell.rowspan - 1;
        col++;
      }
      if (col > TABLE_COLUMNS) return undefined;
    }
    for (; col < carry.length; col++) {
      if (carry[col] > 0) carry[col]--;
      out.push({ text: '', th: false });
    }
    grid.push(out);
  }
  const columns = Math.max(...grid.map((r) => r.length));
  if (columns < 2 || columns > TABLE_COLUMNS) return undefined;
  // A header row when the page has one (in a <thead>, or all <th>);
  // else an empty one, since a pipe table must open with a header.
  const first = ordered[0];
  const headed = first.head || first.cells.every((c) => c.th);
  const header = headed ? grid.shift()! : [];
  // A cell's `|` is escaped, in a link's address or code too, so it
  // splits no cell; its words are already escaped as markdown.
  const line = (cells: string[]) =>
    `| ${Array.from({ length: columns }, (_, i) => (cells[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
  const lines = [
    line(header.map((c) => c.text)),
    line(Array.from({ length: columns }, () => '---')),
    // A header cell down the side is bold, as the page draws it.
    ...grid.map((r) => line(r.map((c) => (c.th && c.text ? `*${c.text}*` : c.text)))),
  ];
  const named = caption ? words(s.slice(caption.innerStart, caption.innerEnd)) : '';
  // A caption is a line above, its own paragraph, where no `|` splits it.
  return `${named ? `${named}\n\n` : ''}${lines.join('\n')}`;
}

/**
 * `html` as markdown, links and images resolved against `base` and kept
 * only when http(s). Not a browser: nesting beyond lists in lists comes
 * out as its words in order, which is the point; a data table is a
 * pipe table, and a table laying out a page is its cells, each a
 * paragraph (2026-11-17).
 */
export function htmlToMarkdown(html: string, base: string, max = CONTENT_MAX): string {
  const blocks: string[] = [];
  const keep = (text: string) => {
    blocks.push(text);
    return `\u0000${blocks.length - 1}\u0000`;
  };
  // Kept blocks can hold kept blocks (an image inside a link): restored
  // until none remain, bounded, so no marker ever reaches a note.
  const restore = (text: string) => {
    let out = text;
    for (let pass = 0; pass < 5 && /\u0000\d+\u0000/.test(out); pass++) {
      out = out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)] ?? '');
    }
    return out.replace(/\u0000\d*\u0000?/g, '');
  };
  // The page's own control characters go first: the converter's
  // markers are made of them.
  // Then every `<` that starts no tag is made a word, and an element
  // opened but never closed loses its tag: the patterns below run from
  // an open tag to its close, and from such a `<` they ran across the
  // page each time (review, 2026-11-16).
  let s = codeButtonsAsSpans(
    unclosedOpensDropped(escapeStrayLt(visibleHtml(html).replace(/[\u0000-\u0002]/g, ' '))),
  ).replace(DROP, ' ');
  // Code first: nothing inside it is markup to read.
  s = s.replace(inner('pre'), (_, body: string) => {
    const code = decode(body.replace(/<[^>]+>/g, '')).replace(/^\n+|\s+$/g, '');
    // A fence longer than any run of backticks in the code, so a line of
    // them in it cannot end the block and let what follows be read as
    // markdown (CLAUDE.md: page text stays words); notes read a fence of
    // four or more as one, closed only by one as long.
    const run = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
    const fence = '`'.repeat(Math.max(3, run + 1));
    // A block of its own: the tags become paragraph breaks below.
    return `<div>${keep(`${fence}\n${code}\n${fence}`)}</div>`;
  });
  s = s.replace(inner('code'), (_, body: string) => {
    const code = decode(body.replace(/<[^>]+>/g, ''))
      .replace(/`/g, 'ˋ')
      .trim();
    return code ? keep(`\`${code}\``) : '';
  });
  // From here the words are the words: entities read, markdown escaped,
  // and the page's own line breaks mere spaces.
  s = escapeText(s.replace(/\s+/g, ' '));
  // Images: https only, lazily by the app; a data: or http: one is its words.
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = escapeMarkdown(attr(tag, 'alt')).replace(/\s+/g, ' ').trim();
    const src = webLink(attr(tag, 'src'), base);
    if (src?.startsWith('https:')) return soft(keep(`![${alt}](${src})`));
    return alt ? soft(alt) : ' ';
  });
  // Inline marks, innermost first so nesting unwinds.
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, __, t: string) =>
        t.trim() ? soft(`*${t.trim()}*`) : ' ',
      )
      .replace(/<(i|em|cite)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, __, t: string) =>
        t.trim() ? soft(`_${t.trim()}_`) : ' ',
      );
  }
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, tag: string, body: string) => {
    // The words settled here: kept as a block, they miss the pass below.
    const text = settle(body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
    // A link with no words is dropped, not printed as its address; a
    // link within the page (a heading's own anchor) is its words.
    if (!text) return ' ';
    const raw = attr(tag, 'href');
    const href = !raw || raw.startsWith('#') ? undefined : webLink(raw, base);
    if (!href) return soft(text);
    return soft(keep(`[${text}](${href})`));
  });
  // Tables (#313, 2026-11-17): a data table as a pipe table, kept
  // whole; a layout table read as its cells, below, each a paragraph,
  // and the tables inside it each read on its own.
  if (/<table\b/i.test(s)) {
    const cellWords = (html: string) =>
      restore(settle(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim());
    const edits: Edit[] = [];
    walk(parseTree(s), (el) => {
      if (el.name !== 'table') return true;
      const md = pipeTable(s, el, cellWords);
      if (md === undefined) return true;
      edits.push({ start: el.start, end: el.end, text: `<div>${keep(md)}</div>` });
      return false;
    });
    s = applyEdits(s, edits);
  }
  // Blocks.
  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, n: string, t: string) => {
      const level = Math.min(Number(n) + 1, 6);
      return `\n\n${'#'.repeat(level)} ${t.replace(/\s+/g, ' ').trim()}\n\n`;
    })
    .replace(/<ol\b[^>]*>([\s\S]*?)<\/ol\s*>/gi, (_, body: string) => {
      let n = 0;
      return `\n\n${body.replace(/<li\b[^>]*>/gi, () => `\n${++n}. `)}\n\n`;
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_, body: string) => {
      const lines = body
        .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      return `\n\n${lines.map((l) => `> ${l}`).join('\n')}\n\n`;
    })
    .replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(
      /<\/?(p|div|section|article|header|footer|aside|main|figure|figcaption|table|caption|thead|tbody|tfoot|tr|td|th|ul|ol|dl|dt|dd|details|summary|address|fieldset)\b[^>]*>/gi,
      '\n\n',
    )
    .replace(/<[^>]+>/g, ' ');
  const text = s
    .split('\n')
    .map((l) => settle(l.replace(/[ \t\r\f\v]+/g, ' ')).trim())
    // An item whose only link or image was dropped is no item.
    .filter((l) => !/^(?:-|\d+\.)$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const out = restore(text)
    .replace(/\u0001/g, ' ')
    .replace(/\u0002/g, '<');
  return out.length <= max ? out : cut(out, max);
}

/**
 * Cut on a line, then a word, so a link is never left half written; a
 * pipe table the cut lands in keeps its whole rows, or goes from its
 * start when no body row would be left (2026-11-17).
 */
function cut(text: string, max: number): string {
  const head = text.slice(0, max);
  const at = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '));
  const kept = head.slice(0, at > max / 2 ? at : max).trimEnd();
  const rest = wholeRows(text, kept);
  return `${rest ? `${rest}\n\n` : ''}…`;
}

/**
 * `kept`, the start of `text`, with the pipe table it ends in left
 * valid: its last row goes unless the text breaks the line right
 * after it, and the table goes from its start when no body row is
 * left under the header and the delimiter. Lines of `|` whose second,
 * read in `text`, is no delimiter are no table.
 */
function wholeRows(text: string, kept: string): string {
  const line = kept.lastIndexOf('\n') + 1;
  if (!kept.startsWith('|', line)) return kept;
  // Back over the lines of `|` to the first: each line read once.
  let start = line;
  let rows = 1;
  while (start > 0) {
    const prev = kept.lastIndexOf('\n', start - 2) + 1;
    if (prev === start || !kept.startsWith('|', prev)) break;
    start = prev;
    rows++;
  }
  const from = text.indexOf('\n', start) + 1;
  const to = text.indexOf('\n', from);
  const delimiter = from ? text.slice(from, to < 0 ? text.length : to) : '';
  if (!/^\|[ :|-]+\|$/.test(delimiter) || !delimiter.includes('-')) return kept;
  const whole = text.startsWith('\n', kept.length);
  if (rows - (whole ? 0 : 1) < 3) return kept.slice(0, start).trimEnd();
  return whole ? kept : kept.slice(0, line).trimEnd();
}

/** The first words of markdown as plain text, for the compact list. */
export function summaryOf(markdown: string, max = SUMMARY_MAX): string {
  const words = markdown
    .replace(/(`{3,})[\s\S]*?\1`*/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/^---$/gm, ' ')
    // A pipe table's rows as their cells' words (2026-11-17).
    .replace(/^\|[ :|-]+\|$/gm, ' ')
    .replace(/^\|.*\|$/gm, (row) => row.replace(/(?<!\\)\|/g, ' '))
    .replace(/(^|[^\\])[*_`]/g, '$1')
    .replace(/\\([\\*_`[\]#|])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (words.length <= max) return words;
  const head = words.slice(0, max);
  const at = head.lastIndexOf(' ');
  return `${head.slice(0, at > max / 2 ? at : max)}…`;
}
