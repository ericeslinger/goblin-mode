// Reading a feed (#161): RSS 2.0, Atom, RSS 1.0 (RDF) and JSON Feed into
// one shape. Pure over text, so the fixtures run in specs. Feeds break
// in the usual ways: CDATA, relative links, missing or unreadable dates,
// repeated guids, content in one of three places; each is handled here
// so the refresher never sees it.
import { XMLParser } from 'fast-xml-parser';

export interface ParsedItem {
  /** What names the item across refreshes: its guid or id, else its link, else its title. */
  guid: string;
  title: string;
  /** Absolute, resolved against the feed. */
  link: string;
  author?: string;
  /** Milliseconds, when the feed said. */
  published?: number;
  /** The item's content as the feed gave it, HTML or plain text. */
  html: string;
}

export interface ParsedFeed {
  title: string;
  site?: string;
  items: ParsedItem[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  // Namespaces as written (content:encoded, dc:creator), not stripped.
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

type Node = Record<string, unknown> | string | number | undefined | null;

const list = (v: unknown): Record<string, unknown>[] =>
  v === undefined || v === null
    ? []
    : (Array.isArray(v) ? v : [v]).filter((x): x is Record<string, unknown> => !!x);

/** An element's text, CDATA included, as one string. */
function text(node: Node): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  const own = node['#text'];
  const cdata = node['#cdata'];
  const parts = [own, cdata].filter((p) => p !== undefined && p !== null).map(String);
  if (parts.length) return parts.join('').trim();
  // Atom `type="xhtml"`: the content is child elements; their text will do.
  return Object.entries(node)
    .filter(([k]) => !k.startsWith('@'))
    .map(([, v]) => (Array.isArray(v) ? v.map(text).join(' ') : text(v as Node)))
    .join(' ')
    .trim();
}

/** The first of several elements that has text. */
function first(node: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    const t = text(list(node[n])[0] ?? (typeof node[n] === 'string' ? node[n] : undefined));
    if (t) return t;
  }
  return '';
}

function absolute(link: string, base: string): string {
  // An empty link is no link, not the feed's own address.
  if (!link.trim()) return '';
  try {
    const url = new URL(link.trim(), base);
    // Only a web link is kept (review on #168): a javascript: or data:
    // "link" in a feed is no page to open or clip.
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function when(value: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  // Dates written the common wrong ways: a bare "YYYY-MM-DD HH:MM:SS".
  const fixed = Number.isNaN(ms) ? Date.parse(value.replace(' ', 'T')) : ms;
  return Number.isNaN(fixed) ? undefined : fixed;
}

/** Atom links: `rel="alternate"` (or none) with an href, the first one. */
function atomLink(entry: Record<string, unknown>, base: string): string {
  const links = list(entry['link']);
  const alt =
    links.find((l) => !l['@rel'] || l['@rel'] === 'alternate') ??
    links.find((l) => typeof l['@href'] === 'string');
  const href = alt?.['@href'];
  if (typeof href === 'string') return absolute(href, base);
  const plain = typeof entry['link'] === 'string' ? entry['link'] : '';
  return plain ? absolute(plain, base) : '';
}

function fromRss(channel: Record<string, unknown>, base: string): ParsedFeed {
  const site = first(channel, 'link');
  return {
    title: first(channel, 'title'),
    ...(site ? { site: absolute(site, base) } : {}),
    items: list(channel['item']).map((item) => {
      const link = absolute(first(item, 'link'), base);
      const title = first(item, 'title');
      const guid = first(item, 'guid') || link || title;
      const date = first(item, 'pubDate', 'dc:date', 'date');
      const author = first(item, 'dc:creator', 'author');
      return {
        guid,
        title,
        link,
        ...(author ? { author } : {}),
        ...(when(date) === undefined ? {} : { published: when(date) }),
        html: first(item, 'content:encoded', 'description', 'summary'),
      };
    }),
  };
}

function fromRdf(root: Record<string, unknown>, base: string): ParsedFeed {
  const channel = list(root['channel'])[0] ?? {};
  const site = first(channel, 'link');
  return {
    title: first(channel, 'title'),
    ...(site ? { site: absolute(site, base) } : {}),
    // RSS 1.0 lists items beside the channel, not inside it.
    items: list(root['item']).map((item) => {
      const link = absolute(first(item, 'link') || String(item['@rdf:about'] ?? ''), base);
      const title = first(item, 'title');
      const date = first(item, 'dc:date');
      const author = first(item, 'dc:creator');
      return {
        guid: String(item['@rdf:about'] ?? '') || link || title,
        title,
        link,
        ...(author ? { author } : {}),
        ...(when(date) === undefined ? {} : { published: when(date) }),
        html: first(item, 'content:encoded', 'description'),
      };
    }),
  };
}

function fromAtom(feed: Record<string, unknown>, base: string): ParsedFeed {
  const site = atomLink(feed, base);
  return {
    title: first(feed, 'title'),
    ...(site ? { site } : {}),
    items: list(feed['entry']).map((entry) => {
      const link = atomLink(entry, base);
      const title = first(entry, 'title');
      const date = first(entry, 'published', 'updated');
      const author = text(list(entry['author'])[0]?.['name'] as Node);
      return {
        guid: first(entry, 'id') || link || title,
        title,
        link,
        ...(author ? { author } : {}),
        ...(when(date) === undefined ? {} : { published: when(date) }),
        html: first(entry, 'content', 'summary'),
      };
    }),
  };
}

function fromJson(source: string, base: string): ParsedFeed | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as { items?: unknown }).items)) {
    return undefined;
  }
  const feed = doc as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const site = str(feed['home_page_url']);
  return {
    title: str(feed['title']),
    ...(site ? { site: absolute(site, base) } : {}),
    items: list(feed['items']).map((item) => {
      const link = absolute(str(item['url']) || str(item['external_url']), base);
      const title = str(item['title']);
      const date = str(item['date_published']) || str(item['date_modified']);
      const authors = list(item['authors']);
      const author = str(authors[0]?.['name']) || str(list(item['author'])[0]?.['name']);
      return {
        guid: str(item['id']) || link || title,
        title,
        link,
        ...(author ? { author } : {}),
        ...(when(date) === undefined ? {} : { published: when(date) }),
        html: str(item['content_html']) || str(item['content_text']) || str(item['summary']),
      };
    }),
  };
}

/**
 * The feed in `source`, fetched from `url` (for relative links), or
 * undefined when it is no feed this reads. Items with neither a title
 * nor a link are dropped; the first of two items with one guid stays.
 */
export function parseFeed(source: string, url: string): ParsedFeed | undefined {
  const trimmed = source.replace(/^﻿/, '').trimStart();
  let feed: ParsedFeed | undefined;
  if (trimmed.startsWith('{')) feed = fromJson(trimmed, url);
  else {
    let root: Record<string, unknown>;
    try {
      root = parser.parse(trimmed) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const rss = list(root['rss'])[0];
    const rdf = list(root['rdf:RDF'])[0] ?? list(root['RDF'])[0];
    const atom = list(root['feed'])[0];
    if (rss) feed = fromRss(list(rss['channel'])[0] ?? {}, url);
    else if (rdf) feed = fromRdf(rdf, url);
    else if (atom) feed = fromAtom(atom, url);
  }
  if (!feed) return undefined;
  const seen = new Set<string>();
  feed.items = feed.items.filter((i) => {
    if (!i.title && !i.link) return false;
    if (seen.has(i.guid)) return false;
    seen.add(i.guid);
    return true;
  });
  return feed;
}
