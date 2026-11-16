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
  xmlChars,
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

describe('OPML hardening (#254)', () => {
  // The parser as it was before #254, kept as the oracle: on OPML as
  // exporters write it the linear scan must read the same feeds.
  function oldParseOpml(text: string) {
    const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    const decode = (t: string) =>
      t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
        if (name[0] === '#') {
          const code =
            name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : +name.slice(1);
          return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return ENT[name.toLowerCase()] ?? whole;
      });
    const attributes = (tag: string) => {
      const out: Record<string, string> = {};
      for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? '');
      }
      return out;
    };
    const byUrl = new Map<
      string,
      { url: string; title: string; site?: string; folders: string[] }
    >();
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
          byUrl.set(url, { url, title: name || url, ...(site ? { site } : {}), folders });
        }
        if (!closed) stack.push('');
      } else if (!closed) {
        stack.push(name);
      }
    }
    return [...byUrl.values()];
  }

  const SAMPLES = [
    FEEDLY,
    toOpml(
      [
        {
          url: 'https://kiln.test/rss',
          title: 'Kiln & "talk"',
          site: 'https://kiln.test/',
          folders: ['Making'],
        },
        { url: 'https://glaze.test/rss', title: "Glaze's <lab>", folders: [] },
        { url: 'https://both.test/rss', title: 'Both', folders: ['Making', 'Art'] },
      ],
      'Podcasts from Mossgoblin',
    ),
    // Inoreader-style: no declaration, upper-case tags, single quotes, spaces around =.
    `<opml version='2.0'><body>
<OUTLINE TEXT = 'Tech' >
  <OUTLINE TYPE='rss' TEXT='Ars' XMLURL = 'http://feeds.arstechnica.com/arstechnica/index' HTMLURL='https://arstechnica.com'/>
</OUTLINE >
<outline text="Loose" xmlUrl="https://loose.example/rss" htmlUrl=""/>
</body></opml>`,
    // NetNewsWire-style: tabs, newlines inside tags, entities, a folder in a folder.
    `<?xml version="1.0"?>\n<opml version="1.1">\n<body>\n\t<outline text="News &amp; views">\n\t\t<outline text="Deep">\n\t\t\t<outline\n\t\t\t\ttext="&#x201C;Quoted&#8221;"\n\t\t\t\txmlUrl="https://q.example/feed?a=1&amp;b=2"\n\t\t\t\thtmlUrl="https://q.example/"\n\t\t\t\ttype="rss"/>\n\t\t</outline>\n\t</outline>\n\t<outline text="Empty folder"></outline>\n\t<outline title="Titled only" xmlUrl="https://t.example/rss"></outline>\n</body>\n</opml>`,
    // Podcast app export: an outlines-named element and comments around.
    `<opml><body><!-- exported --><outlines/><outline text="Pods"><outline type="rss" text="A" xmlUrl="https://a.example/pod"/><outline type="rss" text="A again" xmlUrl="https://a.example/pod#x"/></outline><outline text="B" xmlUrl="ftp://b.example"/></body></opml>`,
    '',
    'not xml <outline',
  ];

  it('reads valid OPML exactly as the old pattern did', () => {
    for (const sample of SAMPLES) expect(parseOpml(sample)).toEqual(oldParseOpml(sample));
    expect(parseOpml(SAMPLES[2]).map((f) => f.folders)).toEqual([['Tech'], []]);
  });

  it('parses 5 MB of unterminated outline tags in well under a second', () => {
    const tags = '<outline '.repeat(Math.ceil(5_000_000 / 9));
    const quotes = '<outline a="'.repeat(Math.ceil(5_000_000 / 12));
    const names = '<outline ' + 'a'.repeat(5_000_000) + '>';
    const open = '<outline text="x" xmlUrl="https://x.example/f" b="' + ' '.repeat(5_000_000);
    const started = performance.now();
    expect(parseOpml(tags)).toEqual([]);
    expect(parseOpml(quotes)).toEqual([]);
    expect(parseOpml(names)).toEqual([]);
    expect(parseOpml(open)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps a site only when it is a web link, and the feed either way', () => {
    expect(
      parseOpml(
        '<outline text="Bad" xmlUrl="https://bad.example/rss" htmlUrl=" javascript:alert(1) "/>' +
          '<outline text="Data" xmlUrl="https://data.example/rss" htmlUrl="data:text/html,hi"/>' +
          '<outline text="Good" xmlUrl="https://good.example/rss" htmlUrl=" http://good.example/ "/>',
      ),
    ).toEqual([
      { url: 'https://bad.example/rss', title: 'Bad', folders: [] },
      { url: 'https://data.example/rss', title: 'Data', folders: [] },
      { url: 'https://good.example/rss', title: 'Good', site: 'http://good.example/', folders: [] },
    ]);
  });

  it('reads a > inside a quoted value as part of it', () => {
    expect(
      parseOpml(
        '<outline text="A > B"><outline text=\'x>y\' xmlUrl="https://x.example/f?a>b"/></outline>' +
          '<outline text="It\'s" xmlUrl="https://y.example/f"/>',
      ),
    ).toEqual([
      { url: 'https://x.example/f?a%3Eb', title: 'x>y', folders: ['A > B'] },
      { url: 'https://y.example/f', title: "It's", folders: [] },
    ]);
  });

  it('takes out every character XML 1.0 does not allow, by code point', () => {
    expect(xmlChars('a\u0000b\u0008c\u000bd\u000ce\u001ff')).toBe('abcdef');
    expect(xmlChars('tab\tlf\ncr\r')).toBe('tab\tlf\ncr\r');
    expect(xmlChars('x\ufffey\uffffz\ufffd')).toBe('xyz\ufffd');
    expect(xmlChars('lone \ud800 high, lone \udfff low, \udc00\ud800 backwards')).toBe(
      'lone  high, lone  low,  backwards',
    );
    expect(xmlChars('\ud7ff\ue000 kiln \u{1F3FA} \u{10FFFF}')).toBe(
      '\ud7ff\ue000 kiln \u{1F3FA} \u{10FFFF}',
    );
    const text = toOpml(
      [
        {
          url: 'https://k.test/rss',
          title: 'Kiln \u{1F3FA}\ud800\uffff\u0001',
          site: 'https://k.test/',
          folders: ['Fold\ufffe'],
        },
      ],
      'Pods\udfff',
    );
    expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/);
    expect(text).not.toMatch(
      /(?:[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff])/,
    );
    expect(text).toContain('<title>Pods</title>');
    expect(parseOpml(text)).toEqual([
      {
        url: 'https://k.test/rss',
        title: 'Kiln \u{1F3FA}',
        site: 'https://k.test/',
        folders: ['Fold'],
      },
    ]);
  });
});
