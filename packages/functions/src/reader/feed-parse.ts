// Reading a feed (#161): RSS 2.0, Atom, RSS 1.0 (RDF) and JSON Feed into
// one shape. Pure over text, so the fixtures run in specs. Feeds break
// in the usual ways: CDATA, relative links, missing or unreadable dates,
// repeated guids, content in one of three places; each is handled here
// so the refresher never sees it. Podcasts (#178): an item's audio
// enclosure, its duration, artwork and episode number, read from RSS
// `<enclosure>` and the itunes: tags, Atom `rel="enclosure"` links and
// JSON Feed attachments. The feed's own artwork (#246): the channel's
// image, `itunes:image` then RSS `<image><url>`, Atom `logo` then
// `icon`, JSON Feed `icon` then `favicon`, a web link only.
import { XMLParser } from 'fast-xml-parser';
import { decode } from '../attachments/import';

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
  /** A podcast episode's audio (#178): the first audio enclosure. */
  enclosure?: Enclosure;
  /** The episode's artwork, else the show's (#178). */
  image?: string;
  /** The episode's number, when the feed says (#178). */
  episode?: number;
}

/** An item's audio (#178); `bytes` as the feed stated, `seconds` its duration. */
export interface Enclosure {
  url: string;
  type: string;
  bytes?: number;
  seconds?: number;
}

export interface ParsedFeed {
  title: string;
  site?: string;
  /** The feed's own artwork (#246), an http(s) link, when it names one. */
  image?: string;
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

/**
 * A title or a name as plain words: tags out and entities read, once
 * more after the XML parser, since feeds double-encode them or put
 * them in CDATA (Eric's "don&#8217;t", 2026-11-07).
 */
const plain = (value: string) =>
  decode(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

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

/**
 * A duration in seconds from `h:mm:ss`, `mm:ss` or plain seconds
 * (#178), as itunes:duration and JSON Feed write it; undefined for
 * anything else.
 */
export function durationSeconds(value: string | number | undefined): number | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  const t = (value ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.\d+)?$/.exec(t);
  if (!m) return undefined;
  const [h, min, sec] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  if (sec > 59 || (m[1] !== undefined && min > 59)) return undefined;
  return h * 3600 + min * 60 + sec;
}

/** Whether an enclosure is audio: its type says so, or with none, its file does (#178). */
function isAudio(type: string, url: string): boolean {
  if (type) return type.toLowerCase().startsWith('audio/');
  return /\.(mp3|m4a|ogg|oga|opus|aac)(?:[?#]|$)/i.test(url);
}

/** A stated byte length, when it is a whole number above zero. */
function byteLength(value: unknown): number | undefined {
  const n = Number(typeof value === 'string' ? value.trim() : value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** The first audio enclosure among candidates, its link resolved and http(s) only. */
function audio(
  candidates: { url: unknown; type: unknown; length: unknown; seconds?: number }[],
  base: string,
  itemSeconds?: number,
): Enclosure | undefined {
  for (const c of candidates) {
    const seconds = c.seconds ?? itemSeconds;
    const url = typeof c.url === 'string' ? absolute(c.url, base) : '';
    const type = typeof c.type === 'string' ? c.type.trim() : '';
    if (!url || !isAudio(type, url)) continue;
    const bytes = byteLength(c.length);
    return {
      url,
      type: type || 'audio/mpeg',
      ...(bytes === undefined ? {} : { bytes }),
      ...(seconds === undefined ? {} : { seconds }),
    };
  }
  return undefined;
}

/** A positive whole episode number, when there is one. */
function episodeOf(value: string): number | undefined {
  const n = Number(value.trim());
  return value.trim() && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** An `itunes:image href` as an http(s) link. */
function itunesImage(node: Record<string, unknown>, base: string): string {
  const href = list(node['itunes:image'])[0]?.['@href'];
  return typeof href === 'string' ? absolute(href, base) : '';
}

/** An RSS `<image><url>`, the channel's picture, as an http(s) link (#246). */
function rssImage(node: Record<string, unknown>, base: string): string {
  return absolute(first(list(node['image'])[0] ?? {}, 'url'), base);
}

/** The first of several links that is a web link, or nothing. */
const firstLink = (...links: string[]) => links.find(Boolean) ?? '';

/** The podcast fields of an item, only those it has. */
function podcast(
  enclosure: Enclosure | undefined,
  image: string,
  episode: number | undefined,
): Pick<ParsedItem, 'enclosure' | 'image' | 'episode'> {
  return {
    ...(enclosure ? { enclosure } : {}),
    // Artwork and number belong to episodes; an article keeps neither.
    ...(enclosure && image ? { image } : {}),
    ...(enclosure && episode !== undefined ? { episode } : {}),
  };
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
  const show = itunesImage(channel, base);
  const image = firstLink(show, rssImage(channel, base));
  return {
    title: plain(first(channel, 'title')),
    ...(site ? { site: absolute(site, base) } : {}),
    ...(image ? { image } : {}),
    items: list(channel['item']).map((item) => {
      const link = absolute(first(item, 'link'), base);
      const rawTitle = first(item, 'title');
      const title = plain(rawTitle);
      // The guid falls back to the title as written, so cleaning it never renames an item (review on #169).
      const guid = first(item, 'guid') || link || rawTitle;
      const date = first(item, 'pubDate', 'dc:date', 'date');
      const author = plain(first(item, 'dc:creator', 'author'));
      const enclosure = audio(
        list(item['enclosure']).map((e) => ({
          url: e['@url'],
          type: e['@type'],
          length: e['@length'],
        })),
        base,
        durationSeconds(first(item, 'itunes:duration')),
      );
      return {
        guid,
        title,
        link,
        ...(author ? { author } : {}),
        ...(when(date) === undefined ? {} : { published: when(date) }),
        html: first(item, 'content:encoded', 'description', 'summary'),
        ...podcast(
          enclosure,
          itunesImage(item, base) || show,
          episodeOf(first(item, 'itunes:episode')),
        ),
      };
    }),
  };
}

function fromRdf(root: Record<string, unknown>, base: string): ParsedFeed {
  const channel = list(root['channel'])[0] ?? {};
  const site = first(channel, 'link');
  // RSS 1.0 puts the image beside the channel, the channel naming it.
  const image = firstLink(rssImage(root, base), rssImage(channel, base));
  return {
    title: plain(first(channel, 'title')),
    ...(site ? { site: absolute(site, base) } : {}),
    ...(image ? { image } : {}),
    // RSS 1.0 lists items beside the channel, not inside it.
    items: list(root['item']).map((item) => {
      const link = absolute(first(item, 'link') || String(item['@rdf:about'] ?? ''), base);
      const rawTitle = first(item, 'title');
      const title = plain(rawTitle);
      const date = first(item, 'dc:date');
      const author = plain(first(item, 'dc:creator'));
      return {
        guid: String(item['@rdf:about'] ?? '') || link || rawTitle,
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
  const show = itunesImage(feed, base);
  const image = firstLink(
    show,
    absolute(first(feed, 'logo'), base),
    absolute(first(feed, 'icon'), base),
  );
  return {
    title: plain(first(feed, 'title')),
    ...(site ? { site } : {}),
    ...(image ? { image } : {}),
    items: list(feed['entry']).map((entry) => {
      const link = atomLink(entry, base);
      const rawTitle = first(entry, 'title');
      const title = plain(rawTitle);
      const date = first(entry, 'published', 'updated');
      const author = plain(text(list(entry['author'])[0]?.['name'] as Node));
      const enclosure = audio(
        list(entry['link'])
          .filter((l) => l['@rel'] === 'enclosure')
          .map((l) => ({ url: l['@href'], type: l['@type'], length: l['@length'] })),
        base,
        durationSeconds(first(entry, 'itunes:duration')),
      );
      return {
        guid: first(entry, 'id') || link || rawTitle,
        title,
        link,
        ...(author ? { author } : {}),
        ...(when(date) === undefined ? {} : { published: when(date) }),
        html: first(entry, 'content', 'summary'),
        ...podcast(
          enclosure,
          itunesImage(entry, base) || show,
          episodeOf(first(entry, 'itunes:episode')),
        ),
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
  const show = absolute(str(feed['icon']), base);
  const image = firstLink(show, absolute(str(feed['favicon']), base));
  return {
    title: plain(str(feed['title'])),
    ...(site ? { site: absolute(site, base) } : {}),
    ...(image ? { image } : {}),
    items: list(feed['items']).map((item) => {
      const link = absolute(str(item['url']) || str(item['external_url']), base);
      const rawTitle = str(item['title']);
      const title = plain(rawTitle);
      const date = str(item['date_published']) || str(item['date_modified']);
      const authors = list(item['authors']);
      const author = str(authors[0]?.['name']) || str(list(item['author'])[0]?.['name']);
      // JSON Feed gives each attachment its own size and duration.
      const enclosure = audio(
        list(item['attachments']).map((a) => ({
          url: a['url'],
          type: a['mime_type'],
          length: a['size_in_bytes'],
          seconds: durationSeconds(a['duration_in_seconds'] as string | number | undefined),
        })),
        base,
      );
      return {
        guid: str(item['id']) || link || rawTitle,
        title,
        link,
        ...(author ? { author } : {}),
        ...(when(date) === undefined ? {} : { published: when(date) }),
        html: str(item['content_html']) || str(item['content_text']) || str(item['summary']),
        ...podcast(enclosure, absolute(str(item['image']), base) || show, undefined),
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
