import { describe, expect, it } from 'vitest';
import {
  NOT_A_FEED,
  completeFeedHead,
  durationSeconds,
  oldestFirst,
  parseFeed,
  readFeed,
} from './feed-parse';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Kottke &amp; co</title>
  <link>https://kottke.org/</link>
  <item>
    <title>A post</title>
    <link>/26/11/a-post</link>
    <guid isPermaLink="false">tag:kottke,2026:a-post</guid>
    <pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate>
    <dc:creator>Jason</dc:creator>
    <description>Short</description>
    <content:encoded><![CDATA[<p>Long <b>bold</b> &amp; more</p>]]></content:encoded>
  </item>
  <item>
    <title>No guid, odd date</title>
    <link>https://kottke.org/26/11/second</link>
    <pubDate>2026-11-05 09:30:00</pubDate>
    <description><![CDATA[Plain words]]></description>
  </item>
  <item>
    <title>Repeat</title>
    <guid>tag:kottke,2026:a-post</guid>
  </item>
  <item><description>nothing to name it</description></item>
  <item><title>Scripted</title><link>javascript:alert(1)</link><guid>js</guid></item>
  <item><title>Maybe Americans don&amp;#8217;t like &lt;b&gt;cruelty&lt;/b&gt;</title><link>https://kottke.org/26/11/cruelty</link><guid>ent</guid><dc:creator><![CDATA[Christian &amp; Paz]]></dc:creator></item>
</channel>
</rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Daring Fireball</title>
  <link rel="alternate" type="text/html" href="https://daringfireball.net/"/>
  <link rel="self" href="https://daringfireball.net/feeds/main"/>
  <entry>
    <title>Entry</title>
    <link rel="related" href="https://elsewhere.example/"/>
    <link rel="alternate" href="/linked/2026/11/entry"/>
    <id>tag:df,2026:entry</id>
    <published>2026-11-06T12:00:00-05:00</published>
    <updated>2026-11-07T12:00:00-05:00</updated>
    <author><name>John</name></author>
    <content type="html">&lt;p&gt;Hi&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Only a summary</title>
    <link href="https://daringfireball.net/2"/>
    <id>tag:df,2026:2</id>
    <updated>not a date</updated>
    <summary>Sum</summary>
  </entry>
</feed>`;

const RDF = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://old.example/">
    <title>Old school</title>
    <link>https://old.example/</link>
  </channel>
  <item rdf:about="https://old.example/one">
    <title>One</title>
    <link>https://old.example/one</link>
    <dc:date>2026-11-01T00:00:00Z</dc:date>
    <description>First</description>
  </item>
</rdf:RDF>`;

const JSONFEED = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'JSON',
  home_page_url: 'https://json.example/',
  items: [
    {
      id: '1',
      url: '/one',
      title: 'One',
      date_published: '2026-11-02T00:00:00Z',
      authors: [{ name: 'Ann' }],
      content_html: '<p>Hello</p>',
    },
    { id: '2', title: 'Text only', content_text: 'Just text' },
  ],
});

describe('parseFeed (#161)', () => {
  it('reads RSS 2.0: CDATA, relative links, content over description, odd dates, repeats', () => {
    const feed = parseFeed(RSS, 'https://kottke.org/main/index.xml')!;
    expect(feed.title).toBe('Kottke & co');
    expect(feed.site).toBe('https://kottke.org/');
    expect(feed.items).toHaveLength(4);
    expect(feed.items[2]).toMatchObject({ guid: 'js', title: 'Scripted', link: '' });
    // Titles and names as plain words: entities read once more, tags out.
    expect(feed.items[3]).toMatchObject({
      title: 'Maybe Americans don’t like cruelty',
      author: 'Christian & Paz',
    });
    expect(feed.items[0]).toEqual({
      guid: 'tag:kottke,2026:a-post',
      title: 'A post',
      link: 'https://kottke.org/26/11/a-post',
      author: 'Jason',
      published: Date.parse('2026-11-06T10:00:00Z'),
      html: '<p>Long <b>bold</b> &amp; more</p>',
    });
    expect(feed.items[1]).toMatchObject({
      guid: 'https://kottke.org/26/11/second',
      published: Date.parse('2026-11-05T09:30:00'),
      html: 'Plain words',
    });
  });

  it('reads Atom: the alternate link, published over updated, content over summary', () => {
    const feed = parseFeed(ATOM, 'https://daringfireball.net/feeds/main')!;
    expect(feed.site).toBe('https://daringfireball.net/');
    expect(feed.items[0]).toEqual({
      guid: 'tag:df,2026:entry',
      title: 'Entry',
      link: 'https://daringfireball.net/linked/2026/11/entry',
      author: 'John',
      published: Date.parse('2026-11-06T17:00:00Z'),
      html: '<p>Hi</p>',
    });
    expect(feed.items[1]).toEqual({
      guid: 'tag:df,2026:2',
      title: 'Only a summary',
      link: 'https://daringfireball.net/2',
      html: 'Sum',
    });
  });

  it('reads RSS 1.0 and JSON Feed', () => {
    const rdf = parseFeed(RDF, 'https://old.example/rss')!;
    expect(rdf.title).toBe('Old school');
    expect(rdf.items).toEqual([
      {
        guid: 'https://old.example/one',
        title: 'One',
        link: 'https://old.example/one',
        published: Date.parse('2026-11-01T00:00:00Z'),
        html: 'First',
      },
    ]);
    const json = parseFeed(JSONFEED, 'https://json.example/feed.json')!;
    expect(json.site).toBe('https://json.example/');
    expect(json.items[0]).toMatchObject({
      guid: '1',
      link: 'https://json.example/one',
      author: 'Ann',
      html: '<p>Hello</p>',
    });
    expect(json.items[1]).toMatchObject({ guid: '2', link: '', html: 'Just text' });
  });

  it('says when it is no feed', () => {
    expect(parseFeed('<html><body>a page</body></html>', 'https://x.example/')).toBeUndefined();
    expect(parseFeed('{"not": "a feed"}', 'https://x.example/')).toBeUndefined();
    expect(parseFeed('', 'https://x.example/')).toBeUndefined();
    expect(parseFeed('<<<', 'https://x.example/')).toBeUndefined();
  });

  describe('podcasts (#178)', () => {
    const POD = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Kiln talk</title>
  <link>https://kiln.example/</link>
  <itunes:image href="https://kiln.example/show.jpg"/>
  <item>
    <title>Episode two</title>
    <link>https://kiln.example/2</link>
    <guid>kiln-2</guid>
    <pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate>
    <enclosure url="https://cdn.kiln.example/2.mp3" type="audio/mpeg" length="40265318"/>
    <itunes:duration>1:05:09</itunes:duration>
    <itunes:image href="/art/2.jpg"/>
    <itunes:episode>2</itunes:episode>
  </item>
  <item>
    <title>Episode one</title>
    <guid>kiln-1</guid>
    <enclosure url="https://cdn.kiln.example/1.pdf" type="application/pdf" length="10"/>
    <enclosure url="/1.m4a" length="0"/>
    <itunes:duration>2520</itunes:duration>
    <itunes:episode>zero</itunes:episode>
  </item>
  <item>
    <title>Show notes only</title>
    <guid>kiln-notes</guid>
    <enclosure url="https://cdn.kiln.example/cover.jpg" type="image/jpeg" length="10"/>
    <itunes:image href="https://kiln.example/notes.jpg"/>
  </item>
  <item>
    <title>Scripted audio</title>
    <guid>kiln-js</guid>
    <enclosure url="javascript:alert(1)" type="audio/mpeg"/>
  </item>
</channel>
</rss>`;

    it('reads an RSS enclosure, itunes:duration, itunes:image and itunes:episode', () => {
      const feed = parseFeed(POD, 'https://kiln.example/feed.xml')!;
      expect(feed.items[0]).toMatchObject({
        guid: 'kiln-2',
        enclosure: {
          url: 'https://cdn.kiln.example/2.mp3',
          type: 'audio/mpeg',
          bytes: 40265318,
          seconds: 3909,
        },
        image: 'https://kiln.example/art/2.jpg',
        episode: 2,
      });
      // The first audio one; a type-less file counts by its name; the show's art.
      expect(feed.items[1].enclosure).toEqual({
        url: 'https://kiln.example/1.m4a',
        type: 'audio/mpeg',
        seconds: 2520,
      });
      expect(feed.items[1].image).toBe('https://kiln.example/show.jpg');
      expect(feed.items[1].episode).toBeUndefined();
      // No audio, no episode: an article keeps none of the podcast fields.
      for (const item of feed.items.slice(2)) {
        expect(item).not.toHaveProperty('enclosure');
        expect(item).not.toHaveProperty('image');
        expect(item).not.toHaveProperty('episode');
      }
    });

    it('reads an Atom enclosure link', () => {
      const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <title>Atom pod</title>
  <entry>
    <title>One</title>
    <id>a-1</id>
    <link rel="alternate" href="https://atom.example/1"/>
    <link rel="enclosure" type="audio/ogg" length="1234" href="/1.ogg"/>
    <itunes:duration>42:00</itunes:duration>
  </entry>
  <entry>
    <title>Two</title>
    <id>a-2</id>
    <link rel="enclosure" type="video/mp4" href="https://atom.example/2.mp4"/>
  </entry>
</feed>`;
      const feed = parseFeed(atom, 'https://atom.example/feed')!;
      expect(feed.items[0].link).toBe('https://atom.example/1');
      expect(feed.items[0].enclosure).toEqual({
        url: 'https://atom.example/1.ogg',
        type: 'audio/ogg',
        bytes: 1234,
        seconds: 2520,
      });
      expect(feed.items[1]).not.toHaveProperty('enclosure');
    });

    it('reads JSON Feed attachments', () => {
      const json = JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'JSON pod',
        icon: 'https://json.example/icon.png',
        items: [
          {
            id: '1',
            title: 'One',
            attachments: [
              { url: 'https://json.example/1.txt', mime_type: 'text/plain' },
              {
                url: 'https://json.example/1.mp3',
                mime_type: 'audio/mpeg',
                size_in_bytes: 900,
                duration_in_seconds: 61.4,
              },
            ],
          },
          { id: '2', title: 'Two', image: 'https://json.example/2.png' },
        ],
      });
      const feed = parseFeed(json, 'https://json.example/feed.json')!;
      expect(feed.items[0]).toMatchObject({
        enclosure: {
          url: 'https://json.example/1.mp3',
          type: 'audio/mpeg',
          bytes: 900,
          seconds: 61,
        },
        image: 'https://json.example/icon.png',
      });
      expect(feed.items[1]).not.toHaveProperty('enclosure');
      expect(feed.items[1]).not.toHaveProperty('image');
    });

    it('reads a duration as h:mm:ss, mm:ss or seconds, and nothing else', () => {
      expect(durationSeconds('1:05:09')).toBe(3909);
      expect(durationSeconds('01:00:00')).toBe(3600);
      expect(durationSeconds('42:07')).toBe(2527);
      expect(durationSeconds('75:30')).toBe(4530);
      expect(durationSeconds('2520')).toBe(2520);
      expect(durationSeconds(' 90.6 ')).toBe(91);
      expect(durationSeconds(61)).toBe(61);
      for (const junk of ['', 'an hour', '1:2:3:4', '1:75', '1:60:00', '-5', 'NaN', undefined]) {
        expect(durationSeconds(junk)).toBeUndefined();
      }
      expect(durationSeconds(-1)).toBeUndefined();
    });
  });

  describe("the feed's artwork (#246)", () => {
    const rss = (channel: string) =>
      `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>T</title>${channel}<item><title>a</title><guid>1</guid></item></channel></rss>`;

    it('reads RSS itunes:image first, then the channel <image><url>', () => {
      const base = 'https://kiln.example/feed.xml';
      expect(
        parseFeed(
          rss(
            '<image><url>https://kiln.example/rss.png</url><title>T</title></image><itunes:image href="/itunes.jpg"/>',
          ),
          base,
        )!.image,
      ).toBe('https://kiln.example/itunes.jpg');
      expect(
        parseFeed(
          rss('<image><url>/rss.png</url><link>https://kiln.example/</link></image>'),
          base,
        )!.image,
      ).toBe('https://kiln.example/rss.png');
      // A link that is not a web one is no artwork; none at all is none.
      expect(
        parseFeed(rss('<itunes:image href="javascript:alert(1)"/>'), base)!,
      ).not.toHaveProperty('image');
      expect(parseFeed(rss(''), base)!).not.toHaveProperty('image');
    });

    it('reads RSS 1.0 <image> beside the channel', () => {
      const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="https://rdf.example/"><title>R</title><image rdf:resource="https://rdf.example/logo.gif"/></channel>
  <image rdf:about="https://rdf.example/logo.gif"><url>https://rdf.example/logo.gif</url></image>
  <item rdf:about="https://rdf.example/1"><title>One</title></item>
</rdf:RDF>`;
      expect(parseFeed(rdf, 'https://rdf.example/feed.rdf')!.image).toBe(
        'https://rdf.example/logo.gif',
      );
    });

    it('reads Atom logo, then icon', () => {
      const atom = (head: string) =>
        `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>${head}<entry><title>One</title><id>1</id></entry></feed>`;
      const base = 'https://atom.example/feed';
      expect(parseFeed(atom('<icon>/icon.png</icon><logo>/logo.png</logo>'), base)!.image).toBe(
        'https://atom.example/logo.png',
      );
      expect(parseFeed(atom('<icon>https://cdn.atom.example/i.png</icon>'), base)!.image).toBe(
        'https://cdn.atom.example/i.png',
      );
      expect(parseFeed(atom(''), base)!).not.toHaveProperty('image');
    });

    it('reads JSON Feed icon, then favicon', () => {
      const json = (head: object) =>
        JSON.stringify({
          version: 'https://jsonfeed.org/version/1.1',
          title: 'J',
          ...head,
          items: [{ id: '1', title: 'One' }],
        });
      const base = 'https://json.example/feed.json';
      expect(parseFeed(json({ icon: '/big.png', favicon: '/small.png' }), base)!.image).toBe(
        'https://json.example/big.png',
      );
      expect(parseFeed(json({ favicon: '/small.png' }), base)!.image).toBe(
        'https://json.example/small.png',
      );
      expect(parseFeed(json({ icon: 'data:image/png;base64,AAAA' }), base)!).not.toHaveProperty(
        'image',
      );
    });
  });
  it('keeps the markup of Atom xhtml content: links, emphasis and paragraphs (Eric, 2026-11-11)', () => {
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ongoing</title>
  <entry>
    <title>Long Links</title>
    <link href="https://blog.example/long-links"/>
    <id>tag:blog,2026:long-links</id>
    <updated>2026-11-08T12:00:00-08:00</updated>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
      <p>I haven\u2019t done a <i>Long Links</i> since June.</p>
      <p>I recommended <a href="https://colors.example/">STORIED COLORS</a>, then
      <a href="/reply">Lachlan replied</a> &amp; so on.</p>
    </div></content>
  </entry>
  <entry>
    <title>Empty</title>
    <link href="https://blog.example/empty"/>
    <id>tag:blog,2026:empty</id>
    <content type="xhtml"/>
    <summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Short <b>one</b></div></summary>
  </entry>
</feed>`,
      'https://blog.example/feed',
    )!;
    const html = feed.items[0].html;
    expect(html).toContain('<p>I haven\u2019t done a <i>Long Links</i> since June.</p>');
    expect(html).toContain('<a href="https://colors.example/">STORIED COLORS</a>, then');
    expect(html).toContain('&amp; so on.</p>');
    // An empty xhtml content falls back to the summary, markup kept.
    expect(feed.items[1].html).toContain('Short <b>one</b>');
  });
  it('reads xhtml content holding ]]> whole, and leaves markup quoted in CDATA alone (review on #258)', () => {
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>t</title>
  <entry>
    <title>One</title><link href="https://b.example/1"/><id>1</id>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>a ]]&gt; b ]]> c</p></div></content>
  </entry>
  <entry>
    <title>Two</title><link href="https://b.example/2"/><id>2</id>
    <content type="html"><![CDATA[<p>Write <code>&lt;content type="xhtml"&gt;x&lt;/content&gt;</code> or <content type="xhtml">y</content> and more.</p>]]></content>
  </entry>
</feed>`,
      'https://b.example/feed',
    )!;
    expect(feed.items[0].html).toContain('<p>a ]]&gt; b ]]> c</p>');
    expect(feed.items[1].html).toContain('<content type="xhtml">y</content> and more.</p>');
  });
});

describe('a feed read in part (2026-11-16)', () => {
  const DAY = 86_400_000;
  const T = Date.parse('2026-11-14T07:00:00Z');
  const podItem = (n: number, notes = `<p>Show notes for ${n}.</p>`) =>
    `<item><title>Episode ${n}</title><link>https://pod.test/${n}</link><guid>ep-${n}</guid>` +
    `<pubDate>${new Date(T - (1000 - n) * 3 * DAY).toUTCString()}</pubDate>` +
    `<description><![CDATA[${notes}]]></description>` +
    `<enclosure url="https://pod.test/${n}.mp3" type="audio/mpeg" length="1000"/></item>`;
  const HEAD =
    '<?xml version="1.0"?>\n<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>' +
    '<title>Kiln hour</title><link>https://pod.test/</link><itunes:image href="https://pod.test/show.jpg"/>';
  /** A podcast's feed, newest first, `count` episodes from 1000 down. */
  const pod = (count: number, notes?: (n: number) => string) =>
    HEAD +
    Array.from({ length: count }, (_, i) => podItem(1000 - i, notes?.(1000 - i))).join('') +
    '</channel></rss>';
  /** The first `bytes` of a text's UTF-8, decoded as the fetcher does. */
  const cut = (text: string, bytes: number) =>
    new TextDecoder().decode(new TextEncoder().encode(text).slice(0, bytes));
  const titles = (text: string) =>
    parseFeed(text, 'https://pod.test/feed')!.items.map((i) => i.title);

  it('cuts an RSS head after its last complete item and closes it', () => {
    const whole = pod(3);
    const at = whole.indexOf('<title>Episode 998');
    const head = completeFeedHead(whole.slice(0, at + 10))!;
    expect(head.endsWith('</item></channel></rss>')).toBe(true);
    expect(titles(head)).toEqual(['Episode 1000', 'Episode 999']);
  });

  it('cuts before a CDATA section the cut landed in', () => {
    const whole = pod(3);
    const at = whole.indexOf('Show notes for 998');
    expect(titles(completeFeedHead(whole.slice(0, at))!)).toEqual(['Episode 1000', 'Episode 999']);
  });

  it('passes over an </item> inside show notes, in a closed section or the open one', () => {
    const quoting = pod(3, (n) => `<p>${n}: we wrote </item> on air.</p>`);
    // The cut lands after the quoted tag in 998's notes, before its section closes.
    const open = quoting.indexOf('</item> on air', quoting.indexOf('998: we wrote')) + 12;
    expect(titles(completeFeedHead(quoting.slice(0, open))!)).toEqual([
      'Episode 1000',
      'Episode 999',
    ]);
    // A closed section's quoted tag is no item's end either.
    const head = completeFeedHead(quoting.slice(0, quoting.indexOf('<item>', open)))!;
    expect(titles(head)).toEqual(['Episode 1000', 'Episode 999', 'Episode 998']);
    expect(head.endsWith('/></item></channel></rss>')).toBe(true);
  });

  it('drops a character cut in half', () => {
    const whole = pod(2, () => '<p>Glazes 🔥 and celadon é</p>');
    const bytes = new TextEncoder().encode(whole);
    // Into the second item's four-byte emoji, one byte in.
    const second = whole.indexOf('<item>', whole.indexOf('</item>'));
    const at = new TextEncoder().encode(whole.slice(0, whole.indexOf('🔥', second))).length + 1;
    const text = new TextDecoder().decode(bytes.slice(0, at));
    expect(text.endsWith('\uFFFD')).toBe(true);
    const head = completeFeedHead(text)!;
    expect(head).not.toContain('\uFFFD');
    expect(parseFeed(head, 'https://pod.test/feed')!.items[0].html).toContain('🔥');
  });

  it('reads an Atom head and an RDF head', () => {
    const atom =
      '<?xml version="1.0"?><!-- a comment --><feed xmlns="http://www.w3.org/2005/Atom"><title>Dice</title>' +
      '<entry><title>One</title><id>1</id><link href="https://a.test/1"/></entry>' +
      '<entry><title>Two</title><id>2</id><link href="https://a.test/2"/></entry>' +
      '<entry><title>Thr';
    const a = completeFeedHead(atom)!;
    expect(a.endsWith('</entry></feed>')).toBe(true);
    expect(titles(a)).toEqual(['One', 'Two']);
    const rdf =
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">' +
      '<channel rdf:about="https://r.test/"><title>Old</title><link>https://r.test/</link></channel>' +
      '<item rdf:about="https://r.test/1"><title>First</title><link>https://r.test/1</link></item>' +
      '<item rdf:about="https://r.test/2"><title>Sec';
    const r = completeFeedHead(rdf)!;
    expect(r.endsWith('</item></rdf:RDF>')).toBe(true);
    expect(titles(r)).toEqual(['First']);
  });

  it('gives nothing for a head with no complete item, a JSON Feed or no feed', () => {
    expect(completeFeedHead(HEAD + '<item><title>Episode 1</title><description><![CDATA[lo')).toBe(
      undefined,
    );
    expect(completeFeedHead('{"version":"https://jsonfeed.org/version/1.1","items":[{"id":')).toBe(
      undefined,
    );
    expect(completeFeedHead('<html><body><p>a </item> page</p>')).toBe(undefined);
  });

  it('reads a feed over 5 MB in part, newest first, its channel kept', () => {
    // Long show notes, as a podcast's back catalogue has: over 5 MB.
    const notes = (n: number) => `<p>${'Notes é '.repeat(700)} ${n}</p>`;
    const big = pod(1000, notes);
    expect(new TextEncoder().encode(big).length).toBeGreaterThan(5 * 1024 * 1024);
    const cap = 5 * 1024 * 1024;
    const read = readFeed(cut(big, cap), 'https://pod.test/feed', cap);
    if (!('feed' in read)) throw new Error(read.error);
    expect(read.feed.title).toBe('Kiln hour');
    expect(read.feed.image).toBe('https://pod.test/show.jpg');
    expect(read.feed.items.length).toBeGreaterThan(500);
    expect(read.feed.items.length).toBeLessThan(1000);
    expect(read.feed.items[0].title).toBe('Episode 1000');
    expect(read.feed.items.every((i) => i.enclosure)).toBe(true);
    // Read whole, the same feed is as it was.
    expect('feed' in readFeed(big, 'https://pod.test/feed')).toBe(true);
  });

  it('says why a feed read in part cannot be read', () => {
    const cap = 5 * 1024 * 1024;
    const url = 'https://pod.test/feed';
    expect(readFeed('{"items":[{"id":"1"', url, cap)).toEqual({
      error: 'a JSON feed over 5 MB cannot be read in part',
    });
    expect(readFeed(HEAD + '<item><title>Episode 1</title>', url, cap)).toEqual({
      error: 'the feed is over 5 MB and its first 5 MB hold no complete item',
    });
    expect(readFeed('<!doctype html><html><body>', url, cap)).toEqual({ error: NOT_A_FEED });
    // Oldest first: the head holds only the old ones.
    const ascending =
      HEAD + [1, 2, 3, 4].map((n) => podItem(n)).join('') + '<item><title>Episode 5</title>';
    expect(readFeed(ascending, url, cap)).toEqual({
      error: 'the feed is over 5 MB and lists its oldest items first, so its newest cannot be read',
    });
    // Whole, the same order is fine: everything is there.
    expect(
      'feed' in
        readFeed(ascending.slice(0, ascending.lastIndexOf('<item>')) + '</channel></rss>', url),
    ).toBe(true);
  });

  it('knows oldest first from newest first, an old trailer on top included', () => {
    const at = (...days: number[]) => days.map((d) => ({ published: T - d * DAY }));
    expect(oldestFirst(at(9, 6, 3, 0))).toBe(true);
    expect(oldestFirst(at(0, 3, 6, 9))).toBe(false);
    // A trailer from years back pinned at the top of a newest-first feed.
    expect(oldestFirst(at(2000, 0, 3, 6, 9, 12))).toBe(false);
    expect(oldestFirst([{ published: T }, {}, { published: T }])).toBe(false);
    expect(oldestFirst(at(0.1, 0))).toBe(false);
  });
});
