import {
  feedTrouble,
  findTarget,
  looksText,
  needsAttention,
  newestText,
  nextText,
  unnamed,
} from './feed-health';
import type { FeedRecord } from './reader.service';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const H = 3_600_000;

const feed = (over: Partial<FeedRecord>): FeedRecord => ({
  id: over.id ?? 'f1',
  url: 'https://livelaugh.blog/feed',
  title: 'Live laugh',
  folders: ['Friends'],
  dead: false,
  ...over,
});

describe('feedTrouble: what the fetcher stored, in words, with its fixes (2026-11-15)', () => {
  it('is nothing for a feed whose last look went well, or the Feedly saves', () => {
    expect(feedTrouble(feed({ fetchedAt: NOW }))).toBeUndefined();
    expect(feedTrouble(feed({ url: '', error: 'x' }))).toBeUndefined();
  });

  it('reads 404 and 410 as a moved feed: Find the feed first', () => {
    const t = feedTrouble(feed({ error: 'the site answered 404' }))!;
    expect(t.kind).toBe('moved');
    expect(t.words).toBe('The address answers 404: nothing is there now. The feed may have moved.');
    expect(t.fixes).toEqual(['find', 'remove']);
    expect(feedTrouble(feed({ error: 'the site answered 410' }))!.words).toMatch(/410: .*gone/);
    expect(feedTrouble(feed({ error: 'a redirect with nowhere to go (301)' }))!.kind).toBe('moved');
  });

  it('reads a page that is not a feed as fixable the same way', () => {
    const t = feedTrouble(feed({ error: 'not a feed this can read (RSS, Atom or JSON Feed)' }))!;
    expect(t.kind).toBe('not-a-feed');
    expect(t.fixes).toEqual(['find', 'remove']);
  });

  it('reads a refusing status as the site not letting Mossgoblin in: Try again, Remove', () => {
    for (const status of [401, 402, 403, 429, 451]) {
      const t = feedTrouble(feed({ error: `the site answered ${status}` }))!;
      expect(t.kind).toBe('refused');
      expect(t.words).toBe(`The site does not let Mossgoblin read it (it answered ${status}).`);
      expect(t.fixes).toEqual(['retry', 'remove']);
    }
  });

  it('reads a name that resolves nowhere, a failed connection and 5xx as maybe gone', () => {
    const gone = feedTrouble(feed({ error: 'getaddrinfo ENOTFOUND old.example' }))!;
    expect(gone.kind).toBe('no-host');
    expect(gone.words).toMatch(/name leads nowhere now\. It may be gone\./);
    expect(gone.fixes).toEqual(['retry', 'find', 'remove']);
    expect(feedTrouble(feed({ error: 'old.example is not a public address' }))!.kind).toBe(
      'no-host',
    );
    expect(feedTrouble(feed({ error: 'fetch failed' }))!.kind).toBe('unreachable');
    expect(feedTrouble(feed({ error: 'The operation was aborted due to timeout' }))!.kind).toBe(
      'unreachable',
    );
    const down = feedTrouble(feed({ error: 'the site answered 503' }))!;
    expect(down.kind).toBe('down');
    expect(down.words).toMatch(/^The site answered 503: it is having trouble/);
  });

  it('shows anything else as stored', () => {
    const t = feedTrouble(feed({ error: 'the page is over 5 MB' }))!;
    expect(t.kind).toBe('other');
    expect(t.words).toBe('The last look failed: the page is over 5 MB.');
    expect(t.fixes).toEqual(['retry', 'find', 'remove']);
  });

  it('says a feed was given up, with its last answer', () => {
    const t = feedTrouble(feed({ dead: true, error: 'getaddrinfo ENOTFOUND old.example' }))!;
    expect(t.kind).toBe('dead');
    expect(t.words).toMatch(
      /^Given up after a month of failed looks\. The last answer: The site’s/,
    );
    expect(t.fixes).toEqual(['retry', 'find', 'remove']);
  });
});

describe('needsAttention', () => {
  it('lists the fixable first, then refused, then maybe gone, then given up; by name within', () => {
    const list = needsAttention([
      feed({ id: 'fine', title: 'Fine', fetchedAt: NOW }),
      feed({ id: 'dead', title: 'Antique', dead: true }),
      feed({ id: 'dns', title: 'Bygone', error: 'getaddrinfo ENOTFOUND b.example' }),
      feed({ id: '403', title: 'Closed', error: 'the site answered 403' }),
      feed({ id: 'page', title: 'Zine', error: 'not a feed this can read' }),
      feed({ id: '404', title: 'Live laugh', error: 'the site answered 404' }),
    ]);
    expect(list.map((a) => a.feed.id)).toEqual(['404', 'page', '403', 'dns', 'dead']);
  });
});

describe('a feed’s looks, in words', () => {
  it('says how many failed and when, the next look, and the newest article', () => {
    const f = feed({
      error: 'the site answered 404',
      errorCount: 6,
      fetchedAt: NOW - 2 * H,
      nextFetchAt: NOW + 5 * H,
      lastItemAt: NOW - 400 * 24 * H,
    });
    expect(looksText(f, NOW)).toBe('6 looks in a row have failed, the last 2 h ago.');
    expect(nextText(f, NOW)).toBe('Next look in 5 h.');
    expect(newestText(f, NOW)).toBe('Newest article 13 months ago.');
    expect(looksText(feed({ fetchedAt: NOW - 30 * 60_000 }), NOW)).toBe(
      'Last looked at 30 min ago.',
    );
    expect(looksText(feed({}), NOW)).toBe('Not looked at yet.');
    expect(nextText(feed({ nextFetchAt: NOW - 1 }), NOW)).toMatch(/within 15 minutes/);
    expect(nextText(feed({ dead: true }), NOW)).toMatch(/until you try again/);
    expect(newestText(feed({}), NOW)).toBe('No article read from it yet.');
  });
});

describe('findTarget and unnamed', () => {
  it('looks at the site when known, else the feed host’s home page', () => {
    expect(findTarget(feed({ site: 'https://livelaugh.blog/about' }))).toBe(
      'https://livelaugh.blog/about',
    );
    expect(findTarget(feed({}))).toBe('https://livelaugh.blog/');
  });

  it('knows a title that is only the address or host', () => {
    expect(unnamed({ title: 'livelaugh.blog', url: 'https://livelaugh.blog/feed' })).toBe(true);
    expect(
      unnamed({ title: 'https://livelaugh.blog/feed', url: 'https://livelaugh.blog/feed' }),
    ).toBe(true);
    expect(unnamed({ title: 'Live laugh', url: 'https://livelaugh.blog/feed' })).toBe(false);
  });
});
