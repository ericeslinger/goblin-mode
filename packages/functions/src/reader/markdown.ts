// An article's HTML as the app's markdown (#161): headings, paragraphs,
// lists, quotes, code, links and images, everything else to words.
// Hidden elements go first (visibleHtml, CLAUDE.md: page text), then the
// structure is kept as the notes grammar writes it: *bold*, _italic_.
// Pure over text; the fetcher caps and stores the result on the item.
import { escapeMarkdown } from '@mossgoblin/schema';
import { decode, visibleHtml } from '../attachments/import';

/** The most of an article's content kept, in characters. */
export const CONTENT_MAX = 20_000;
/** The first lines shown in the compact list, in characters. */
export const SUMMARY_MAX = 300;

/** Elements whose contents are never words for a reader. */
const DROP =
  /<(script|style|noscript|svg|math|iframe|object|embed|form|button|input|select|textarea|video|audio|canvas|map|head)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

const inner = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return decode(m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
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

/** The text between tags escaped; tags and placeholders left as they are. */
function escapeText(html: string): string {
  return html
    .split(/(<[^>]+>|\u0000\d+\u0000)/)
    .map((part, i) => (i % 2 ? part : escapeMarkdown(decode(part))))
    .join('');
}

/**
 * `html` as markdown, links and images resolved against `base` and kept
 * only when http(s). Not a browser: nesting beyond lists in lists and
 * tables come out as their words in order, which is the point.
 */
export function htmlToMarkdown(html: string, base: string, max = CONTENT_MAX): string {
  const blocks: string[] = [];
  const keep = (text: string) => {
    blocks.push(text);
    return `\u0000${blocks.length - 1}\u0000`;
  };
  let s = visibleHtml(html).replace(DROP, ' ');
  // Code first: nothing inside it is markup to read.
  s = s.replace(inner('pre'), (_, body: string) => {
    const code = decode(body.replace(/<[^>]+>/g, '')).replace(/^\n+|\s+$/g, '');
    // A block of its own: the tags become paragraph breaks below.
    return `<div>${keep(`\`\`\`\n${code}\n\`\`\``)}</div>`;
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
    if (src?.startsWith('https:')) return ` ${keep(`![${alt}](${src})`)} `;
    return alt ? ` ${alt} ` : ' ';
  });
  // Inline marks, innermost first so nesting unwinds.
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, __, t: string) =>
        t.trim() ? ` *${t.trim()}* ` : ' ',
      )
      .replace(/<(i|em|cite)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, __, t: string) =>
        t.trim() ? ` _${t.trim()}_ ` : ' ',
      );
  }
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, tag: string, body: string) => {
    const text = body
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const href = webLink(attr(tag, 'href'), base);
    if (!href) return ` ${text} `;
    return ` ${keep(`[${text || href}](${href})`)} `;
  });
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
      /<\/?(p|div|section|article|header|footer|aside|main|figure|figcaption|table|thead|tbody|tr|ul|ol|dl|dt|dd|details|summary|address|fieldset)\b[^>]*>/gi,
      '\n\n',
    )
    .replace(/<\/(td|th)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = s
    .split('\n')
    .map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Kept blocks can hold kept blocks (an image inside a link): restore
  // until none remain, bounded, so no marker ever reaches a note.
  let out = text;
  for (let pass = 0; pass < 5 && /\u0000\d+\u0000/.test(out); pass++) {
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)] ?? '');
  }
  out = out.replace(/\u0000\d*\u0000?/g, '');
  return out.length <= max ? out : cut(out, max);
}

/** Cut on a line, then a word, so a link is never left half written. */
function cut(text: string, max: number): string {
  const head = text.slice(0, max);
  const at = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '));
  return `${head.slice(0, at > max / 2 ? at : max).trimEnd()}\n\n…`;
}

/** The first words of markdown as plain text, for the compact list. */
export function summaryOf(markdown: string, max = SUMMARY_MAX): string {
  const words = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/^---$/gm, ' ')
    .replace(/(^|[^\\])[*_`]/g, '$1')
    .replace(/\\([\\*_`[\]#])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (words.length <= max) return words;
  const head = words.slice(0, max);
  const at = head.lastIndexOf(' ');
  return `${head.slice(0, at > max / 2 ? at : max)}…`;
}
