import { describe, expect, it } from 'vitest';
import {
  UNCATEGORIZED,
  feedId,
  feedItemId,
  fnv64,
  folderList,
  normalizeFeedUrl,
  parseOpml,
} from './reader';

const FEEDLY = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Eric subscriptions in feedly Cloud</title></head>
  <body>
    <outline text="Design" title="Design">
      <outline type="rss" text="Kottke &amp; co" title="Kottke &amp; co" xmlUrl="https://kottke.org/main/index.xml#frag" htmlUrl="https://kottke.org/"/>
      <outline type="rss" text="Daring Fireball" xmlUrl="https://daringfireball.net/feeds/main" htmlUrl="https://daringfireball.net/"/>
    </outline>
    <outline text="Games">
      <outline type="rss" text="Kottke &amp; co" xmlUrl="https://kottke.org/main/index.xml" htmlUrl="https://kottke.org/"/>
      <outline type="rss" text="" xmlUrl='https://example.org/feed'></outline>
    </outline>
    <outline type="rss" text="Loose" xmlUrl="https://loose.example/rss"/>
    <outline type="rss" text="Not a link" xmlUrl="ftp://nope.example/rss"/>
  </body>
</opml>`;

describe('the Reader’s derived ids (#159)', () => {
  it('normalises a feed link: trimmed, http(s) only, no fragment', () => {
    expect(normalizeFeedUrl(' https://a.example/feed#x ')).toBe('https://a.example/feed');
    expect(normalizeFeedUrl('http://a.example/feed?x=1')).toBe('http://a.example/feed?x=1');
    expect(normalizeFeedUrl('ftp://a.example/feed')).toBeUndefined();
    expect(normalizeFeedUrl('feed')).toBeUndefined();
  });

  it('hashes the same everywhere, and apart for different text', () => {
    // FNV-1a 64 of the empty string is its offset basis.
    expect(fnv64('')).toBe('cbf29ce484222325');
    expect(fnv64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv64('résumé')).not.toBe(fnv64('resume'));
    expect(feedId('https://a.example/feed')).toMatch(/^f-[0-9a-f]{16}$/);
    expect(feedId('https://a.example/feed')).toBe(feedId('https://a.example/feed'));
    expect(feedItemId('f-1', 'guid-1')).toBe('f-1-' + fnv64('guid-1'));
    expect(feedItemId('f-1', 'guid-1')).not.toBe(feedItemId('f-2', 'guid-1'));
  });
});

describe('parseOpml', () => {
  it('reads Feedly’s export: folders, titles, sites; a repeated feed is one in two folders', () => {
    const feeds = parseOpml(FEEDLY);
    expect(feeds).toEqual([
      {
        url: 'https://kottke.org/main/index.xml',
        title: 'Kottke & co',
        site: 'https://kottke.org/',
        folders: ['Design', 'Games'],
      },
      {
        url: 'https://daringfireball.net/feeds/main',
        title: 'Daring Fireball',
        site: 'https://daringfireball.net/',
        folders: ['Design'],
      },
      { url: 'https://example.org/feed', title: 'https://example.org/feed', folders: ['Games'] },
      { url: 'https://loose.example/rss', title: 'Loose', folders: [] },
    ]);
  });

  it('copes with nesting two deep, entities and no feeds at all', () => {
    const feeds = parseOpml(
      '<opml><body><outline text="A"><outline text="B &#38; C"><outline xmlUrl="https://x.example/f" text="X"/></outline></outline></body></opml>',
    );
    expect(feeds).toEqual([{ url: 'https://x.example/f', title: 'X', folders: ['A', 'B & C'] }]);
    expect(parseOpml('<opml><body/></opml>')).toEqual([]);
    expect(parseOpml('not xml')).toEqual([]);
  });
});

describe('folderList', () => {
  const feeds = [
    { id: 'a', title: 'zeta', folders: ['Games', 'Design'] },
    { id: 'b', title: 'Alpha', folders: [] },
    { id: 'c', title: 'beta', folders: ['Design'] },
  ];

  it('groups feeds by folder, sorted, Uncategorized last, feeds by title', () => {
    expect(folderList(feeds)).toEqual([
      { name: 'Design', feeds: [feeds[2], feeds[0]] },
      { name: 'Games', feeds: [feeds[0]] },
      { name: UNCATEGORIZED, feeds: [feeds[1]] },
    ]);
  });

  it('puts the gardener’s order first', () => {
    expect(folderList(feeds, ['Games', 'Gone']).map((f) => f.name)).toEqual([
      'Games',
      'Design',
      UNCATEGORIZED,
    ]);
  });
});
