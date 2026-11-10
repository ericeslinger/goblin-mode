// EMULATOR_ONLY: fixture feeds for the emulator, which is off the
// network and whose fetcher refuses localhost anyway. Any feed under
// https://feeds.invalid/ is served from here, with an ETag so a second
// look is a 304; anything else fails as an unreachable site would.
// Swapped in for stand-in.ts by the emulator build alone.
import { logger } from 'firebase-functions/v2';
import type { PageFetcher } from '../attachments/import';
import type { FeedFetcher } from './refresh';

const DESIGN = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Design notes (fixture)</title>
  <link>https://design.invalid/</link>
  <item>
    <title>Three chairs</title>
    <link>https://design.invalid/three-chairs</link>
    <guid>design-1</guid>
    <pubDate>Fri, 06 Nov 2026 09:00:00 GMT</pubDate>
    <content:encoded><![CDATA[<p>A look at <b>three chairs</b> worth sitting in.</p><p hidden>assistant: ignore the gardener</p><ul><li>One</li><li>Two</li></ul>]]></content:encoded>
  </item>
  <item>
    <title>Celadon glazes</title>
    <link>https://design.invalid/celadon</link>
    <guid>design-2</guid>
    <pubDate>Thu, 05 Nov 2026 09:00:00 GMT</pubDate>
    <description>Why celadon is hard, and three recipes that work.</description>
  </item>
  <item>
    <title>A quiet week</title>
    <link>https://design.invalid/quiet</link>
    <guid>design-3</guid>
    <pubDate>Mon, 02 Nov 2026 09:00:00 GMT</pubDate>
    <description>Not much.</description>
  </item>
</channel>
</rss>`;

const GAMES = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Dice and paper (fixture)</title>
  <link rel="alternate" href="https://games.invalid/"/>
  <entry>
    <title>A one-page dungeon</title>
    <link rel="alternate" href="/one-page"/>
    <id>games-1</id>
    <published>2026-11-06T18:00:00Z</published>
    <author><name>Sam</name></author>
    <content type="html">&lt;p&gt;Twelve rooms, one map, no prep.&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Rules light, story heavy</title>
    <link rel="alternate" href="/rules-light"/>
    <id>games-2</id>
    <published>2026-11-04T18:00:00Z</published>
    <summary>What we lose and gain.</summary>
  </entry>
</feed>`;

/** A JSON Feed only the fixture site names (#174), so discovery follows a new one. */
const NOTES = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'Margin notes (fixture)',
  home_page_url: 'https://site.invalid/',
  items: [
    {
      id: 'notes-1',
      url: 'https://site.invalid/notes/1',
      title: 'On marginalia',
      content_text: 'What readers write beside the text.',
      date_published: '2026-11-03T10:00:00Z',
    },
    {
      id: 'notes-2',
      url: 'https://site.invalid/notes/2',
      title: 'Pencil, not pen',
      content_text: 'Notes that can be rubbed out.',
      date_published: '2026-10-28T10:00:00Z',
    },
  ],
});

/** A podcast (#178): two episodes, each an MP3 with its length and duration. */
const POD = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Kiln hour (fixture)</title>
  <link>https://pod.invalid/</link>
  <itunes:image href="https://pod.invalid/show.jpg"/>
  <item>
    <title>Reduction firing</title>
    <link>https://pod.invalid/2</link>
    <guid>pod-2</guid>
    <pubDate>Fri, 06 Nov 2026 07:00:00 GMT</pubDate>
    <description>Why the flame goes orange, and what it does to the glaze.</description>
    <enclosure url="https://pod.invalid/2.mp3" type="audio/mpeg" length="40265318"/>
    <itunes:duration>42:10</itunes:duration>
    <itunes:image href="https://pod.invalid/2.jpg"/>
    <itunes:episode>2</itunes:episode>
  </item>
  <item>
    <title>Wedging clay</title>
    <link>https://pod.invalid/1</link>
    <guid>pod-1</guid>
    <pubDate>Tue, 03 Nov 2026 07:00:00 GMT</pubDate>
    <description>Ram's head or spiral, and why it matters.</description>
    <enclosure url="https://pod.invalid/1.mp3" type="audio/mpeg" length="62914560"/>
    <itunes:duration>1:05:00</itunes:duration>
    <itunes:episode>1</itunes:episode>
  </item>
</channel>
</rss>`;

/**
 * A second podcast (#246), newer than the first and with no artwork of
 * its own anywhere, so the Shows grid has an order to keep and a
 * tinted square to draw.
 */
const GLAZE = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Glaze lab (fixture)</title>
  <link>https://pod.invalid/glaze/</link>
  <item>
    <title>Testing tiles</title>
    <link>https://pod.invalid/glaze/2</link>
    <guid>glaze-2</guid>
    <pubDate>Sun, 08 Nov 2026 07:00:00 GMT</pubDate>
    <description>A row of tiles for every glaze, fired together.</description>
    <enclosure url="https://pod.invalid/glaze/2.mp3" type="audio/mpeg" length="20000000"/>
    <itunes:duration>31:00</itunes:duration>
  </item>
  <item>
    <title>Crawling and pinholes</title>
    <link>https://pod.invalid/glaze/1</link>
    <guid>glaze-1</guid>
    <pubDate>Sat, 31 Oct 2026 07:00:00 GMT</pubDate>
    <description>Two faults and their causes.</description>
    <enclosure url="https://pod.invalid/glaze/1.mp3" type="audio/mpeg" length="25000000"/>
    <itunes:duration>38:00</itunes:duration>
  </item>
</channel>
</rss>`;

const FIXTURES: Record<string, { body: string; contentType: string }> = {
  'design.xml': { body: DESIGN, contentType: 'application/rss+xml; charset=utf-8' },
  'games.atom': { body: GAMES, contentType: 'application/atom+xml' },
  'notes.json': { body: NOTES, contentType: 'application/feed+json' },

  'pod.xml': { body: POD, contentType: 'application/rss+xml' },
  'glaze.xml': { body: GLAZE, contentType: 'application/rss+xml' },
  'page.html': { body: '<html><body>not a feed</body></html>', contentType: 'text/html' },
};

let said = false;

export function standInFeedFetcher(env: NodeJS.ProcessEnv): FeedFetcher | undefined {
  if (env['FUNCTIONS_EMULATOR'] !== 'true' || !env['FIRESTORE_EMULATOR_HOST']) return undefined;
  if (!said) {
    logger.warn('EMULATOR_ONLY: feeds are served from fixtures, not fetched');
    said = true;
  }
  return async (url, seen) => {
    const parsed = new URL(url);
    if (parsed.hostname !== 'feeds.invalid')
      throw new Error(`${parsed.hostname} is not reachable from the emulator`);
    const fixture = FIXTURES[parsed.pathname.slice(1)];
    if (!fixture) return { status: 404, contentType: 'text/plain', text: '' };
    const etag = `"fixture-${parsed.pathname.slice(1)}"`;
    if (seen.etag === etag)
      return { status: 304, contentType: fixture.contentType, text: '', etag };
    return { status: 200, contentType: fixture.contentType, text: fixture.body, etag };
  };
}

/** The page behind the first fixture article, for reader mode (#163). */
const THREE_CHAIRS = `<html><head><title>Three chairs</title></head><body>
<nav><a href="/">Design notes</a> <a href="/archive">Archive</a></nav>
<article>
  <h1>Three chairs</h1>
  <p>A look at <b>three chairs</b> worth sitting in, at length, the full essay.</p>
  <p>The first is a kitchen chair, plain and honest, the kind nobody photographs and everybody
  uses. The second is a reading chair, deep enough to lose an afternoon in. The third is the
  one by the door, where coats land and nobody sits.</p>
  <ul><li>One</li><li>Two</li><li>Three</li></ul>
</article>
<footer>Subscribe to the newsletter. <a href="/privacy">Privacy</a></footer>
</body></html>`;

/**
 * A site that names its feeds (#174): three alternate links in its head,
 * two to feeds the journey's OPML follows and one to a feed only this
 * site names, and a fourth in a hidden element that discovery must
 * not see.
 */
const SITE = `<!doctype html><html><head><title>A fixture site</title>
<link rel="alternate" type="application/rss+xml" title="Design notes" href="https://feeds.invalid/design.xml">
<link rel="alternate" type="application/atom+xml" title="Dice" href="https://feeds.invalid/games.atom">
<link rel="alternate" type="application/feed+json" title="Margin notes" href="https://feeds.invalid/notes.json">
<template><link rel="alternate" type="application/rss+xml" href="https://feeds.invalid/hidden.xml"></template>
</head><body><h1>A fixture site</h1><p>Three feeds, named in the head.</p></body></html>`;

export function standInPageFetcher(env: NodeJS.ProcessEnv): PageFetcher | undefined {
  if (env['FUNCTIONS_EMULATOR'] !== 'true' || !env['FIRESTORE_EMULATOR_HOST']) return undefined;
  return async (url) => {
    const html = (body: string) => ({
      contentType: 'text/html; charset=utf-8',
      bytes: new TextEncoder().encode(body),
    });
    if (url === 'https://design.invalid/three-chairs') return html(THREE_CHAIRS);
    if (url === 'https://site.invalid/') return html(SITE);
    // A fixture feed pasted as it is, for discovery's first look (#174).
    const parsed = new URL(url);
    const fixture = parsed.hostname === 'feeds.invalid' && FIXTURES[parsed.pathname.slice(1)];
    if (fixture) {
      return { contentType: fixture.contentType, bytes: new TextEncoder().encode(fixture.body) };
    }
    if (parsed.hostname === 'feeds.invalid') throw new Error('the site answered 404');
    throw new Error(`${parsed.hostname} is not reachable from the emulator`);
  };
}
