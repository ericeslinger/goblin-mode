import { describe, expect, it } from 'vitest';
import {
  UNCATEGORIZED,
  cleanTags,
  clippingBody,
  escapeMarkdown,
  isWebLink,
  webLinkTarget,
  feedId,
  feedItemId,
  fnv64,
  folderList,
  normalizeFeedUrl,
  parseOpml,
  toOpml,
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
    // An entity out of range stays as written rather than throwing (review on #165).
    expect(
      parseOpml('<outline text="&#99999999; &#x110000; &#0;" xmlUrl="https://x.example/f"/>'),
    ).toEqual([{ url: 'https://x.example/f', title: '&#99999999; &#x110000; &#0;', folders: [] }]);
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

describe('clippings (#163)', () => {
  it('escapes a page’s words so nothing reads as syntax', () => {
    expect(escapeMarkdown('price_list *now* [sic] #tag C#5')).toBe(
      'price\\_list \\*now\\* \\[sic\\] \\#tag C#5',
    );
    expect(escapeMarkdown('[[Secret note]] - [ ] buy @goblin')).toBe(
      '\\[\\[Secret note\\]\\] - \\[ \\] buy @goblin',
    );
  });

  it('writes the source line, then the article as stored', () => {
    expect(
      clippingBody({
        title: 'Three chairs',
        link: 'https://design.invalid/three-chairs',
        feedTitle: 'Design *notes*',
        author: 'Ann_B',
        published: Date.parse('2026-11-06T09:00:00Z'),
        content: 'A look at *three chairs*.\n',
      }),
    ).toBe(
      '_From [Design \\*notes\\*](https://design.invalid/three-chairs), by Ann\\_B, 2026-11-06._\n\n' +
        'A look at *three chairs*.',
    );
    expect(
      clippingBody({ title: 't', link: '', feedTitle: 'Feed', published: 0, content: 'x' }),
    ).toBe('_From Feed, 1970-01-01._\n\nx');
  });

  it('never lets a page’s link write syntax or another scheme into the note (review on #168)', () => {
    expect(webLinkTarget('https://e.test/a)[[Private note]](x')).toBe(
      'https://e.test/a%29%5B%5BPrivate%20note%5D%5D%28x',
    );
    expect(webLinkTarget('https://e.test/path_with (parens)')).toBe(
      'https://e.test/path_with%20%28parens%29',
    );
    expect(webLinkTarget('javascript:alert(1)')).toBeUndefined();
    expect(webLinkTarget('data:text/html,hi')).toBeUndefined();
    expect(isWebLink('http://a.test')).toBe(true);
    expect(isWebLink('ftp://a.test')).toBe(false);
    const hostile = clippingBody({
      title: 't',
      link: 'https://e.test/a)[[Private note]](x',
      feedTitle: 'F',
      published: 0,
      content: 'x',
    });
    expect(hostile).toContain('[F](https://e.test/a%29%5B%5BPrivate%20note%5D%5D%28x)');
    expect(hostile).not.toContain('[[');
    expect(
      clippingBody({
        title: 't',
        link: 'javascript:alert(1)',
        feedTitle: 'F',
        published: 0,
        content: 'x',
      }),
    ).toBe('_From F, 1970-01-01._\n\nx');
  });
});

describe('cleanTags (#176)', () => {
  it('trims, collapses, dedupes by case and caps', () => {
    expect(cleanTags(['  Pottery ', 'pottery', 'Two  words', '', 7, 'x'.repeat(70)])).toEqual([
      'Pottery',
      'Two words',
      'x'.repeat(60),
    ]);
    expect(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(20);
  });
});

describe('toOpml (#251)', () => {
  it('writes folders as outlines, a feed in two folders in each, and reads back the same', () => {
    const feeds = [
      {
        url: 'https://kiln.test/rss',
        title: 'Kiln & "talk"',
        site: 'https://kiln.test/',
        folders: ['Making'],
      },
      { url: 'https://glaze.test/rss', title: 'Glaze <lab>', folders: [] },
      { url: 'https://both.test/rss', title: 'Both', folders: ['Making', 'Art'] },
    ];
    const text = toOpml(feeds, 'Podcasts from Mossgoblin');
    expect(text).toContain('<outline text="Making" title="Making">');
    expect(text).toContain('text="Kiln &amp; &quot;talk&quot;"');
    expect(text).toContain('text="Glaze &lt;lab&gt;"');
    expect(text.indexOf('text="Art"')).toBeLessThan(text.indexOf('text="Making"'));
    expect(parseOpml(text)).toEqual([
      { url: 'https://both.test/rss', title: 'Both', folders: ['Art', 'Making'] },
      {
        url: 'https://kiln.test/rss',
        title: 'Kiln & "talk"',
        site: 'https://kiln.test/',
        folders: ['Making'],
      },
      { url: 'https://glaze.test/rss', title: 'Glaze <lab>', folders: [] },
    ]);
  });

  it('writes only web links, the feed’s and its site’s', () => {
    const text = toOpml(
      [
        { url: 'javascript:alert(1)', title: 'Bad', folders: [] },
        { url: 'https://ok.test/rss', title: 'Ok', site: 'javascript:alert(1)', folders: [] },
      ],
      'Podcasts',
    );
    expect(text).not.toContain('javascript');
    expect(parseOpml(text)).toEqual([{ url: 'https://ok.test/rss', title: 'Ok', folders: [] }]);
  });
});
