// The Reader (#159): feeds in folders, imported from an OPML file. Pure
// over text, shared by the app (which parses the file on the device and
// writes the feeds offline) and the functions (which derive the same
// ids for the items they fetch).

/** The most feeds one gardener follows; an import past it is refused. */
export const FEED_CAP = 500;
/** The folder a feed in no folder shows under, as Feedly names it. */
export const UNCATEGORIZED = 'Uncategorized';

/**
 * The feed's URL as the id is made from it: trimmed, http or https only,
 * no fragment. Undefined when it is no such link.
 */
export function normalizeFeedUrl(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  url.hash = '';
  return url.toString();
}

/**
 * FNV-1a over the UTF-8 bytes, 64 bits, as 16 hex characters. Derived
 * ids need the same answer on every device and on the server, with no
 * async crypto; a collision among one gardener's feeds and items is
 * as good as impossible at this width.
 */
export function fnv64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** The id of the feed at `url` (already normalised), the same everywhere. */
export function feedId(url: string): string {
  return `f-${fnv64(url)}`;
}

/** The id of an item: its feed and its guid, or its link when it has none. */
export function feedItemId(feed: string, guidOrLink: string): string {
  return `${feed}-${fnv64(guidOrLink)}`;
}

/** One feed as an OPML file lists it. */
export interface OpmlFeed {
  url: string;
  title: string;
  site?: string;
  /** Folder names, as the file nests them; empty means Uncategorized. */
  folders: string[];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : +name.slice(1);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const NAME_CHAR = /[\w:.-]/;
const SPACE = /\s/;

/**
 * An outline's attributes, names lowercased: each `name="value"` or
 * `name='value'`, read left to right in one pass (#254). It reads what
 * the pattern `([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')` found before,
 * but a long run of name characters with no `=` after it, or a quote
 * never closed, is passed over once rather than once per character.
 */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Where a quote of each kind was last found missing: none after it.
  const unclosed: Record<string, number> = { '"': Infinity, "'": Infinity };
  let at = 0;
  while (at < tag.length) {
    if (!NAME_CHAR.test(tag[at])) {
      at++;
      continue;
    }
    const start = at;
    while (at < tag.length && NAME_CHAR.test(tag[at])) at++;
    // Every start inside this name reaches the same end, so a name that
    // fails fails from all of them: going on from its end is the same.
    const name = tag.slice(start, at);
    let p = at;
    while (p < tag.length && SPACE.test(tag[p])) p++;
    if (tag[p] !== '=') continue;
    p++;
    while (p < tag.length && SPACE.test(tag[p])) p++;
    const quote = tag[p];
    if (quote !== '"' && quote !== "'") continue;
    const close = p + 1 >= unclosed[quote] ? -1 : tag.indexOf(quote, p + 1);
    if (close < 0) {
      unclosed[quote] = Math.min(unclosed[quote], p + 1);
      continue;
    }
    out[name.toLowerCase()] = decode(tag.slice(p + 1, close));
    at = close + 1;
  }
  return out;
}

/**
 * Each outline's opening and closing tags, in the file's order, in one
 * pass (#254): what `<outline\b([^>]*?)(\/?)>|<\/outline\s*>` matched
 * before, but linear, so a file of `<outline ` with no end cannot
 * freeze the tab. An opening tag ends at the first `>` outside a
 * quoted value, since one may hold a `>`; once a tag finds no such
 * end, it and the rest end at their first `>`, as before.
 */
function* outlineTags(text: string): Generator<{ attrs: string; closed: boolean } | 'close'> {
  const find = /<(\/?)outline/gi;
  const significant = /["'>]/g;
  let quotesBroken = false;
  for (let m = find.exec(text); m; m = find.exec(text)) {
    const after = m.index + m[0].length;
    if (m[1]) {
      let p = after;
      while (p < text.length && SPACE.test(text[p])) p++;
      if (text[p] === '>') {
        find.lastIndex = p + 1;
        yield 'close';
      } else find.lastIndex = m.index + 1;
      continue;
    }
    if (after >= text.length || /\w/.test(text[after])) {
      find.lastIndex = m.index + 1;
      continue;
    }
    let end = -1;
    if (!quotesBroken) {
      significant.lastIndex = after;
      for (let s = significant.exec(text); s; s = significant.exec(text)) {
        if (s[0] === '>') {
          end = s.index;
          break;
        }
        // A quote opens a value only after `=`; a stray one is a character.
        let b = s.index - 1;
        while (b >= after && SPACE.test(text[b])) b--;
        if (text[b] !== '=') continue;
        const close = text.indexOf(s[0], s.index + 1);
        if (close < 0) break;
        significant.lastIndex = close + 1;
      }
      // No end outside quotes: from here every tag ends at its first
      // `>`, as before, so a value left open is passed over only once.
      if (end < 0) quotesBroken = true;
    }
    if (quotesBroken) end = text.indexOf('>', after);
    // No `>` at all: no later opening tag can have an end.
    if (end < 0) return;
    const slice = text.slice(after, end);
    const closed = slice.endsWith('/');
    find.lastIndex = end + 1;
    yield { attrs: closed ? slice.slice(0, -1) : slice, closed };
  }
}

/**
 * The feeds in an OPML file, with their folders. Outlines holding an
 * `xmlUrl` are feeds; the ones around them are folders, named by their
 * `text` or `title`. A feed the file lists twice (Feedly repeats one
 * that is in two collections) is one feed in both folders. Not a real
 * XML parser: OPML as exporters write it, which is all this is for.
 */
export function parseOpml(text: string): OpmlFeed[] {
  const byUrl = new Map<string, OpmlFeed>();
  const stack: string[] = [];
  for (const tag of outlineTags(text)) {
    if (tag === 'close') {
      stack.pop();
      continue;
    }
    const attrs = attributes(tag.attrs);
    const closed = tag.closed;
    const name = (attrs['text'] ?? attrs['title'] ?? '').trim();
    const url = attrs['xmlurl'] === undefined ? undefined : normalizeFeedUrl(attrs['xmlurl']);
    if (url) {
      const folders = stack.filter(Boolean);
      const known = byUrl.get(url);
      if (known) {
        for (const f of folders) if (!known.folders.includes(f)) known.folders.push(f);
      } else {
        // Only a web link, as for the feed's own (#254): a `javascript:`
        // site is not stored, though the feed is.
        const given = attrs['htmlurl']?.trim();
        const site = given && isWebLink(given) ? given : undefined;
        byUrl.set(url, {
          url,
          title: name || url,
          ...(site ? { site } : {}),
          folders,
        });
      }
      if (!closed) stack.push('');
    } else if (!closed) {
      stack.push(name);
    }
  }
  return [...byUrl.values()];
}

/**
 * Text with every character XML 1.0 does not allow taken out (#254):
 * it allows tab, LF, CR, U+0020 to U+D7FF, U+E000 to U+FFFD and
 * U+10000 to U+10FFFF, so the other C0 controls, U+FFFE, U+FFFF and a
 * lone surrogate go. Read by code point, so a pair (an emoji) stays.
 */
export function xmlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (
      c === 0x9 ||
      c === 0xa ||
      c === 0xd ||
      (c >= 0x20 && c <= 0xd7ff) ||
      (c >= 0xe000 && c <= 0xfffd) ||
      c >= 0x10000
    ) {
      out += ch;
    }
  }
  return out;
}

/** Text as an XML attribute's value or text: XML's characters only, its five escaped. */
function attr(text: string): string {
  return xmlChars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * An OPML file of these feeds (#251, Podcasts' Export as OPML), one
 * `parseOpml` and other readers take back: a folder is an outline
 * holding its feeds, a feed in several folders is listed in each (as
 * Feedly writes it), and one in none sits at the top. Only http(s)
 * links are written, the feed's and its site's; folders and feeds are
 * sorted by name so the same feeds give the same file.
 */
export function toOpml(
  feeds: readonly Pick<OpmlFeed, 'url' | 'title' | 'site' | 'folders'>[],
  title: string,
): string {
  const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const web = feeds
    .map((f) => ({ ...f, url: normalizeFeedUrl(f.url) }))
    .filter((f): f is typeof f & { url: string } => !!f.url)
    .sort((a, b) => compare(a.title, b.title));
  const line = (f: (typeof web)[number], indent: string) => {
    const site = f.site && isWebLink(f.site) ? ` htmlUrl="${attr(f.site)}"` : '';
    const name = attr(f.title || f.url);
    return `${indent}<outline type="rss" text="${name}" title="${name}" xmlUrl="${attr(f.url)}"${site}/>`;
  };
  const folders = [...new Set(web.flatMap((f) => f.folders.filter(Boolean)))].sort(compare);
  const body = [
    ...folders.flatMap((folder) => [
      `    <outline text="${attr(folder)}" title="${attr(folder)}">`,
      ...web.filter((f) => f.folders.includes(folder)).map((f) => line(f, '      ')),
      '    </outline>',
    ]),
    ...web.filter((f) => !f.folders.some(Boolean)).map((f) => line(f, '    ')),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    `  <head><title>${attr(title)}</title></head>`,
    '  <body>',
    ...body,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

/** A feed as the folder list needs it. */
export interface FolderFeed {
  id: string;
  title: string;
  folders: string[];
}

/** The folders, each with its feeds by title, `order` first, then the rest sorted, Uncategorized last. */
export function folderList<F extends FolderFeed>(
  feeds: readonly F[],
  order: readonly string[] = [],
): { name: string; feeds: F[] }[] {
  const byName = new Map<string, F[]>();
  for (const f of feeds) {
    const names = f.folders.length ? f.folders : [UNCATEGORIZED];
    for (const n of names) byName.set(n, [...(byName.get(n) ?? []), f]);
  }
  const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const rest = [...byName.keys()]
    .filter((n) => !order.includes(n) && n !== UNCATEGORIZED)
    .sort(compare);
  const names = [...order.filter((n) => byName.has(n)), ...rest];
  if (byName.has(UNCATEGORIZED) && !order.includes(UNCATEGORIZED)) names.push(UNCATEGORIZED);
  return names.map((name) => ({
    name,
    feeds: [...byName.get(name)!].sort((a, b) => compare(a.title, b.title)),
  }));
}

/**
 * Markdown's own characters in words from a page, so they stay words:
 * a page's `[[name]]`, `- [ ] do this @goblin` or `#tag` must never
 * read as a wiki link, an item for the assistant or a tag once filed
 * in the garden (CLAUDE.md, page text). A `#` is escaped only where it
 * would start a tag or heading. Used by the fetcher on content and by
 * File in the garden on titles (#163).
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_`[\]]/g, (c) => `\\${c}`).replace(/(^|\s)#(?=[\p{L}\d#])/gu, '$1\\#');
}

/** Whether a link is one a note may carry: http or https, parseable. */
export function isWebLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A page's link as a markdown link target (review on #168): http(s)
 * only, and the characters that would end the target or start other
 * syntax percent-encoded, so `https://e.test/a)[[x]](y` cannot write a
 * wiki link into the note. Undefined when it is no web link.
 */
export function webLinkTarget(link: string): string | undefined {
  if (!isWebLink(link)) return undefined;
  return new URL(link)
    .toString()
    .replace(
      /[()[\]<>`\\\s]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
    );
}

/** What a clipping needs from the article and its feed (#163). */
export interface ClippingSource {
  title: string;
  link: string;
  feedTitle: string;
  author?: string;
  /** Milliseconds. */
  published: number;
  /** The article's markdown, as stored (already escaped by the fetcher). */
  content: string;
}

/**
 * The body of a clipping: one line saying where it is from, then the
 * article as the fetcher stored it. The feed's name and the author are
 * a page's words, so they are escaped; the content already is.
 */
export function clippingBody(from: ClippingSource): string {
  const who = from.author ? `, by ${escapeMarkdown(from.author)}` : '';
  const when = new Date(from.published).toISOString().slice(0, 10);
  const target = webLinkTarget(from.link);
  const source = target
    ? `[${escapeMarkdown(from.feedTitle) || 'the web'}](${target})`
    : escapeMarkdown(from.feedTitle) || 'the web';
  return `_From ${source}${who}, ${when}._\n\n${from.content.trim()}`;
}

/**
 * The feed the Feedly import files a saved article under when the
 * export does not name a feed the gardener follows (#176). It has no
 * link, so the fetcher never looks at it: no `nextFetchAt`, and
 * Refresh skips a feed without a url.
 */
export const SAVES_FEED_ID = 'f-feedly-saves';
export const SAVES_FEED_TITLE = 'Feedly saves';
/** The most tags an article carries, and the longest one (#176). */
export const ITEM_TAGS_MAX = 20;
export const ITEM_TAG_LENGTH = 60;

/**
 * An article's tags as they are kept (#176): words trimmed and spaces
 * collapsed, cut to 60 characters, the first spelling of each kept
 * whatever its case, at most 20. The app and the server both clean.
 */
export function cleanTags(tags: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const t = tag.replace(/\s+/g, ' ').trim().slice(0, ITEM_TAG_LENGTH).trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= ITEM_TAGS_MAX) break;
  }
  return out;
}
