import { describe, expect, it, vi } from 'vitest';
import type { PageFetcher } from '../attachments/import';
import { COMMON_PATHS, alternateLinks, discoverFeeds } from './discover';
import type { FeedFetcher } from './refresh';

const RSS = (title: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>
  <item><title>One</title><link>https://site.test/one</link></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Dice &amp; paper</title>
  <entry><title>A</title><id>a</id><link href="/a"/></entry></feed>`;

const PAGE = `<!doctype html><html><head>
  <title>A site</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="alternate" type="application/rss+xml" title="Posts &amp; notes" href="/posts.xml">
  <link rel="Alternate" type='application/atom+xml; charset=utf-8' href="https://site.test/games.atom#top">
  <link rel="alternate" type="application/rss+xml" href="/posts.xml">
  <link rel="alternate" type="application/feed+json" href="javascript:alert(1)">
  <link rel="alternate" type="text/html" hreflang="fr" href="/fr/">
  <div hidden><link rel="alternate" type="application/rss+xml" href="/hidden.xml"></div>
</head><body>
  <link rel="alternate" type="application/rss+xml" href="/body.xml">
</body></html>`;

const html = (s: string) => ({
  contentType: 'text/html; charset=utf-8',
  bytes: new TextEncoder().encode(s),
});

/** Feeds served from a table; anything else is a 404. */
function feeds(table: Record<string, string>): FeedFetcher {
  return vi.fn(async (url: string) =>
    table[url] === undefined
      ? { status: 404, contentType: 'text/plain', text: '' }
      : { status: 200, contentType: 'application/xml', text: table[url] },
  );
}

describe('feed discovery (#174)', () => {
  it('reads the alternate feed links from the head: resolved, http(s), once, visible only', () => {
    expect(alternateLinks(PAGE, 'https://site.test/blog/')).toEqual([
      { url: 'https://site.test/posts.xml', title: 'Posts & notes' },
      { url: 'https://site.test/games.atom' },
    ]);
    expect(alternateLinks('<html><body>nothing</body></html>', 'https://site.test/')).toEqual([]);
  });

  it('caps the links read off a page at ten', () => {
    const many = Array.from(
      { length: 14 },
      (_, i) => `<link rel="alternate" type="application/rss+xml" href="/f${i}.xml">`,
    ).join('');
    expect(alternateLinks(`<head>${many}</head>`, 'https://site.test/')).toHaveLength(10);
  });

  it('returns the feeds the page names, with their own titles', async () => {
    const page: PageFetcher = vi.fn(async () => html(PAGE));
    const fetchFeed = feeds({
      'https://site.test/posts.xml': RSS('Posts'),
      'https://site.test/games.atom': ATOM,
    });
    expect(await discoverFeeds('https://site.test/blog/', page, fetchFeed)).toEqual({
      feeds: [
        { url: 'https://site.test/posts.xml', title: 'Posts' },
        { url: 'https://site.test/games.atom', title: 'Dice & paper' },
      ],
    });
  });

  it('keeps only candidates that parse as feeds', async () => {
    const page: PageFetcher = async () => html(PAGE);
    const fetchFeed: FeedFetcher = async (url) =>
      url.endsWith('.atom')
        ? { status: 200, contentType: 'text/html', text: '<html><body>a page</body></html>' }
        : { status: 200, contentType: 'application/rss+xml', text: RSS('Posts') };
    expect((await discoverFeeds('https://site.test/', page, fetchFeed)).feeds).toEqual([
      { url: 'https://site.test/posts.xml', title: 'Posts' },
    ]);
  });

  it('tries the usual paths on the site when the page names none, five at most', async () => {
    const page: PageFetcher = async () => html('<html><head></head><body>hi</body></html>');
    const fetchFeed = feeds({ 'https://site.test/atom.xml': ATOM });
    expect(await discoverFeeds('https://site.test/deep/page', page, fetchFeed)).toEqual({
      feeds: [{ url: 'https://site.test/atom.xml', title: 'Dice & paper' }],
    });
    expect(vi.mocked(fetchFeed).mock.calls.map((c) => c[0])).toEqual(
      COMMON_PATHS.slice(0, 5).map((p) => `https://site.test${p}`),
    );
  });

  it('returns the address itself when it is a feed', async () => {
    const page: PageFetcher = async () => ({
      contentType: 'application/rss+xml',
      bytes: new TextEncoder().encode(RSS('Straight')),
    });
    const fetchFeed = feeds({});
    expect(await discoverFeeds('https://site.test/rss', page, fetchFeed)).toEqual({
      feeds: [{ url: 'https://site.test/rss', title: 'Straight' }],
    });
    expect(fetchFeed).not.toHaveBeenCalled();
  });

  it('finds nothing in neither a page nor a feed, and survives a failing candidate', async () => {
    const pdf: PageFetcher = async () => ({
      contentType: 'application/pdf',
      bytes: new Uint8Array([37, 80, 68, 70]),
    });
    expect(await discoverFeeds('https://site.test/a.pdf', pdf, feeds({}))).toEqual({ feeds: [] });
    const page: PageFetcher = async () => html(PAGE);
    const broken: FeedFetcher = async () => {
      throw new Error('site.test is not a public address');
    };
    expect(await discoverFeeds('https://site.test/', page, broken)).toEqual({ feeds: [] });
  });

  it('throws when the address itself cannot be fetched', async () => {
    const page: PageFetcher = async () => {
      throw new Error('the site answered 500');
    };
    await expect(discoverFeeds('https://site.test/', page, feeds({}))).rejects.toThrow('500');
  });
});
