import { describe, expect, it } from 'vitest';
import { parseFeed } from './feed-parse';

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
});
