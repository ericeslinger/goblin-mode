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

/** An outline's attributes, names lowercased. */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? '');
  }
  return out;
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
  for (const m of text.matchAll(/<outline\b([^>]*?)(\/?)>|<\/outline\s*>/gi)) {
    if (m[0].startsWith('</')) {
      stack.pop();
      continue;
    }
    const attrs = attributes(m[1]);
    const closed = m[2] === '/';
    const name = (attrs['text'] ?? attrs['title'] ?? '').trim();
    const url = attrs['xmlurl'] === undefined ? undefined : normalizeFeedUrl(attrs['xmlurl']);
    if (url) {
      const folders = stack.filter(Boolean);
      const known = byUrl.get(url);
      if (known) {
        for (const f of folders) if (!known.folders.includes(f)) known.folders.push(f);
      } else {
        const site = attrs['htmlurl']?.trim();
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
  const source = from.link
    ? `[${escapeMarkdown(from.feedTitle) || 'the web'}](${from.link})`
    : escapeMarkdown(from.feedTitle);
  return `_From ${source}${who}, ${when}._\n\n${from.content.trim()}`;
}
