// Feed discovery (#174): a site's address in, its feeds out. The page is
// fetched through the public fetcher, its `<link rel="alternate">` feeds
// read from the visible HTML, and when it names none the usual paths
// are tried; each candidate is fetched and parsed, so only real feeds
// come back, with their own names. The page reaches no model. Over
// injected fetchers, so it runs in specs.
import { type PageFetcher, decode, visibleHtml } from '../attachments/import';
import { decodeBody } from './fetch';
import { parseFeed } from './feed-parse';
import type { FeedFetcher } from './refresh';

/** Where feeds usually are when a page does not say. */
export const COMMON_PATHS = ['/feed', '/rss', '/atom.xml', '/feed.xml', '/index.xml'];
/** At most this many alternate links are read off a page. */
const MAX_LINKS = 10;
/** At most this many candidates are fetched. */
const MAX_FETCHED = 5;

const FEED_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
]);

export interface AlternateLink {
  url: string;
  title?: string;
}

export interface DiscoveredFeed {
  url: string;
  title: string;
}

/** A tag's attributes, names lowercased, values decoded. */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '').trim();
  }
  return out;
}

const plain = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * The feeds a page names in its head, `<link rel="alternate">` with an
 * RSS, Atom or JSON Feed type, resolved against `base`: http(s) only,
 * each once, at most ten. Hidden elements are dropped first.
 */
export function alternateLinks(html: string, base: string): AlternateLink[] {
  const visible = visibleHtml(html);
  const head =
    /<head\b[^>]*>([\s\S]*?)(?:<\/head\s*>|<body\b)/i.exec(visible)?.[1] ??
    visible.split(/<body\b/i)[0];
  const out: AlternateLink[] = [];
  const seen = new Set<string>();
  for (const m of head.matchAll(/<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const a = attributes(m[1]);
    const rel = (a['rel'] ?? '').toLowerCase().split(/\s+/);
    const type = (a['type'] ?? '').toLowerCase().split(';')[0].trim();
    if (!rel.includes('alternate') || !FEED_TYPES.has(type) || !a['href']) continue;
    let url: URL;
    try {
      url = new URL(a['href'], base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    const title = plain(a['title'] ?? '');
    out.push({ url: href, ...(title ? { title } : {}) });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const isHtml = (contentType: string) =>
  /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType.trim());

/**
 * The feeds at `url`: the address itself when it is one, else the ones
 * its page names, else the ones at the usual paths, each confirmed by
 * parsing it. Empty when there are none; throws when the address
 * itself cannot be fetched.
 */
export async function discoverFeeds(
  url: string,
  fetchPage: PageFetcher,
  fetchFeed: FeedFetcher,
): Promise<{ feeds: DiscoveredFeed[] }> {
  const page = await fetchPage(url);
  const text = decodeBody(page.bytes, page.contentType);
  if (!isHtml(page.contentType)) {
    const itself = parseFeed(text, url);
    return { feeds: itself ? [{ url, title: plain(itself.title) || hostOf(url) }] : [] };
  }
  const named = alternateLinks(text, url);
  const candidates: AlternateLink[] = named.length
    ? named
    : COMMON_PATHS.map((p) => ({ url: new URL(p, url).toString() }));
  const looked = await Promise.all(
    candidates.slice(0, MAX_FETCHED).map(async (c): Promise<DiscoveredFeed | undefined> => {
      try {
        const res = await fetchFeed(c.url, {});
        if (res.status < 200 || res.status >= 300) return undefined;
        const feed = parseFeed(res.text, c.url);
        if (!feed) return undefined;
        return { url: c.url, title: plain(feed.title) || c.title || hostOf(c.url) };
      } catch {
        return undefined;
      }
    }),
  );
  return { feeds: looked.filter((f): f is DiscoveredFeed => !!f) };
}
