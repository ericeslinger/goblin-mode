import { describe, expect, it } from 'vitest';
import { durationSeconds, parseFeed } from './feed-parse';

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
});
