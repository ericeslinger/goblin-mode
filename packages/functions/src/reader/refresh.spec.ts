import { describe, expect, it, vi } from 'vitest';
import { feedItemId } from '@mossgoblin/schema';
import {
  DEAD_AFTER,
  type DueFeed,
  type FeedFetcher,
  type FeedUpdate,
  INTERVAL_MAX,
  INTERVAL_MIN,
  type NewItem,
  type RefreshStore,
  backoff,
  monthsAfter,
  nextInterval,
  refreshDue,
  refreshFeed,
} from './refresh';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const H = 3_600_000;

const RSS = (items: string) =>
  `<rss version="2.0"><channel><title>Kottke</title><link>https://kottke.org/</link>${items}</channel></rss>`;
const item = (guid: string, hoursAgo: number, html = '<p>Words</p>') =>
  `<item><title>${guid}</title><link>https://kottke.org/${guid}</link><guid>${guid}</guid><pubDate>${new Date(NOW - hoursAgo * H).toUTCString()}</pubDate><description><![CDATA[${html}]]></description></item>`;

function store(knownIds: string[] = [], claimed = true) {
  const s = {
    due: vi.fn(async (): Promise<DueFeed[]> => []),
    claim: vi.fn(async (_uid: string, _id: string, _now: number) => claimed),
    known: vi.fn(
      async (_uid: string, ids: string[]) => new Set(ids.filter((i) => knownIds.includes(i))),
    ),
    writeItems: vi.fn(async (_uid: string, _items: NewItem[]) => undefined),
    updateFeed: vi.fn(async (_uid: string, _id: string, _update: FeedUpdate) => undefined),
    countFetch: vi.fn(async () => undefined),
    keepMonths: vi.fn(async (_uid: string): Promise<number | undefined> => undefined),
  } satisfies RefreshStore;
  return s;
}

const feed: DueFeed = {
  uid: 'u1',
  id: 'f-1',
  url: 'https://kottke.org/main/index.xml',
  title: 'kottke.org',
};

const ok =
  (text: string, extra: Partial<Awaited<ReturnType<FeedFetcher>>> = {}): FeedFetcher =>
  async () => ({ status: 200, contentType: 'application/rss+xml', text, etag: 'W/"1"', ...extra });

describe('refreshFeed (#161)', () => {
  it('writes the items not yet stored, names the feed, and plans the next look', async () => {
    const s = store([feedItemId('f-1', 'old')]);
    const fetch = vi.fn(
      ok(RSS(item('new', 1, '<p>Hi <b>there</b></p><p hidden>secret</p>') + item('old', 3))),
    );
    const out = await refreshFeed({ store: s, fetch, now: () => NOW }, { ...feed, etag: 'W/"0"' });
    expect(out).toEqual({ outcome: 'new', added: 1 });
    expect(fetch).toHaveBeenCalledWith(feed.url, { etag: 'W/"0"', lastModified: undefined });
    expect(s.countFetch).toHaveBeenCalledWith('u1', '2026-11-07');
    expect(s.writeItems).toHaveBeenCalledWith('u1', [
      {
        id: feedItemId('f-1', 'new'),
        feedId: 'f-1',
        title: 'new',
        link: 'https://kottke.org/new',
        published: NOW - H,
        summary: 'Hi there',
        content: 'Hi *there*',
        // The word index (#175): the title's and the text's, never the hidden "secret".
        terms: ['new', 'hi'],
      },
    ]);
    expect(s.updateFeed).toHaveBeenCalledWith('u1', 'f-1', {
      title: 'Kottke',
      site: 'https://kottke.org/',
      etag: 'W/"1"',
      lastModified: null,
      fetchedAt: NOW,
      // Two items two hours apart: half the gap.
      nextFetchAt: NOW + 60 * 60_000,
      interval: 60,
      errorCount: 0,
      error: null,
      lastItemAt: NOW - H,
    });
  });

  it('stores nothing older than three months, so a first look is not the archive (Eric, 2026-11-07)', async () => {
    const s = store();
    const old = item('old', 100 * 24);
    const out = await refreshFeed(
      { store: s, fetch: ok(RSS(item('new', 2) + old)), now: () => NOW },
      feed,
    );
    expect(out).toEqual({ outcome: 'new', added: 1 });
    expect(s.writeItems.mock.calls[0][1].map((i) => i.id)).toEqual([feedItemId('f-1', 'new')]);
    expect(s.known).toHaveBeenCalledWith('u1', [feedItemId('f-1', 'new')]);
    // A dormant feed: nothing stored, but its newest date and a daily interval kept (review on #170).
    const dormant = store();
    const out2 = await refreshFeed(
      { store: dormant, fetch: ok(RSS(item('a', 200 * 24) + item('b', 230 * 24))), now: () => NOW },
      feed,
    );
    expect(out2).toEqual({ outcome: 'unchanged', added: 0 });
    expect(dormant.writeItems).not.toHaveBeenCalled();
    expect(dormant.updateFeed.mock.calls[0][2]).toMatchObject({
      lastItemAt: NOW - 200 * 24 * H,
      interval: INTERVAL_MAX,
    });
  });

  it('writes expireAt from the gardener’s keep-for months (#171)', async () => {
    const s = store();
    s.keepMonths.mockResolvedValue(3);
    await refreshFeed({ store: s, fetch: ok(RSS(item('a', 1))), now: () => NOW }, feed);
    const written = s.writeItems.mock.calls[0][1][0];
    expect(written.expireAt).toBe(monthsAfter(NOW - H, 3));
    expect(new Date(written.expireAt!).toISOString()).toBe('2027-02-07T11:00:00.000Z');
    expect(monthsAfter(Date.parse('2026-11-30T00:00:00Z'), 3)).toBe(
      Date.parse('2027-03-02T00:00:00Z'),
    );
  });

  it('writes an episode’s audio, artwork and number, and leaves the feed’s kind alone (#178, #245)', async () => {
    const s = store([feedItemId('f-1', 'ep-1')]);
    const episode = (guid: string, hoursAgo: number, n: number) =>
      `<item><title>${guid}</title><guid>${guid}</guid><pubDate>${new Date(NOW - hoursAgo * H).toUTCString()}</pubDate><enclosure url="https://cdn.example/${guid}.mp3" type="audio/mpeg" length="1000"/><itunes:duration>42:00</itunes:duration><itunes:image href="https://cdn.example/${guid}.jpg"/><itunes:episode>${n}</itunes:episode></item>`;
    const pod = `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Pod</title>${episode('ep-2', 1, 2)}${episode('ep-1', 30, 1)}</channel></rss>`;
    await refreshFeed({ store: s, fetch: ok(pod), now: () => NOW }, feed);
    const [written] = s.writeItems.mock.calls[0][1];
    expect(s.writeItems.mock.calls[0][1]).toHaveLength(1);
    expect(written).toMatchObject({
      id: feedItemId('f-1', 'ep-2'),
      enclosure: {
        url: 'https://cdn.example/ep-2.mp3',
        type: 'audio/mpeg',
        bytes: 1000,
        seconds: 2520,
      },
      image: 'https://cdn.example/ep-2.jpg',
      episode: 2,
    });
    // Whether it is a podcast is the gardener's, by where it was added
    // (#245, 2026-11-10): the fetcher never says, audio or not.
    expect(s.updateFeed.mock.calls[0][2]).not.toHaveProperty('kind');
    const again = store([feedItemId('f-1', 'ep-1'), feedItemId('f-1', 'ep-2')]);
    await refreshFeed({ store: again, fetch: ok(pod), now: () => NOW }, feed);
    expect(again.writeItems).not.toHaveBeenCalled();
    expect(again.updateFeed.mock.calls[0][2]).not.toHaveProperty('kind');
    // An article feed's items carry none of the fields.
    const plain = store();
    await refreshFeed({ store: plain, fetch: ok(RSS(item('a', 1))), now: () => NOW }, feed);
    expect(plain.updateFeed.mock.calls[0][2]).not.toHaveProperty('kind');
    expect(plain.writeItems.mock.calls[0][1][0]).not.toHaveProperty('enclosure');
    expect(plain.writeItems.mock.calls[0][1][0]).not.toHaveProperty('image');
  });

  it('keeps a gardener’s own name for a feed, and an item’s date never in the far future', async () => {
    const s = store();
    const named = { ...feed, title: 'My Kottke', site: 'https://mine.example/' };
    const future = item('soon', -100);
    await refreshFeed({ store: s, fetch: ok(RSS(future)), now: () => NOW }, named);
    const update = s.updateFeed.mock.calls[0][2];
    expect(update).not.toHaveProperty('title');
    expect(update).not.toHaveProperty('site');
    expect(s.writeItems.mock.calls[0][1][0].published).toBe(NOW + 86_400_000);
  });

  it('takes 304 as unchanged, and lets a quiet feed wait longer', async () => {
    const s = store();
    const quiet = { ...feed, lastItemAt: NOW - 30 * 24 * H, interval: 60 };
    const fetch: FeedFetcher = async () => ({ status: 304, contentType: '', text: '' });
    expect(await refreshFeed({ store: s, fetch, now: () => NOW }, quiet)).toEqual({
      outcome: 'unchanged',
      added: 0,
    });
    expect(s.writeItems).not.toHaveBeenCalled();
    expect(s.updateFeed.mock.calls[0][2]).toMatchObject({
      interval: INTERVAL_MAX,
      errorCount: 0,
      error: null,
    });
  });

  it('backs off on an error, says why, and gives a feed up after a month of them', async () => {
    const s = store();
    const failing: FeedFetcher = async () => {
      throw new Error('kottke.org is not a public address');
    };
    await refreshFeed(
      { store: s, fetch: failing, now: () => NOW },
      { ...feed, interval: 60, errorCount: 2 },
    );
    expect(s.updateFeed.mock.calls[0][2]).toEqual({
      fetchedAt: NOW,
      nextFetchAt: NOW + 120 * 60_000,
      interval: 120,
      errorCount: 3,
      error: 'kottke.org is not a public address',
    });
    const status: FeedFetcher = async () => ({ status: 500, contentType: '', text: '' });
    await refreshFeed(
      { store: s, fetch: status, now: () => NOW },
      { ...feed, errorCount: DEAD_AFTER - 1 },
    );
    expect(s.updateFeed.mock.calls[1][2]).toMatchObject({
      error: 'the site answered 500',
      errorCount: DEAD_AFTER,
      dead: true,
    });
    const page: FeedFetcher = async () => ({
      status: 200,
      contentType: 'text/html',
      text: '<html>no</html>',
    });
    await refreshFeed({ store: s, fetch: page, now: () => NOW }, feed);
    expect(s.updateFeed.mock.calls[2][2]).toMatchObject({
      error: expect.stringContaining('not a feed'),
    });
    expect(s.writeItems).not.toHaveBeenCalled();
  });

  it('plans by the posting rate', () => {
    const hourly = [NOW, NOW - H, NOW - 2 * H, NOW - 3 * H];
    expect(nextInterval(hourly, NOW, NOW)).toBe(INTERVAL_MIN);
    const daily = [NOW, NOW - 24 * H, NOW - 48 * H];
    expect(nextInterval(daily, NOW, NOW)).toBe(12 * 60);
    expect(nextInterval([], undefined, NOW)).toBe(INTERVAL_MIN);
    expect(nextInterval([], NOW - 10 * 24 * H, NOW)).toBe(INTERVAL_MAX);
    expect(backoff(undefined)).toBe(60);
    expect(backoff(INTERVAL_MAX)).toBe(INTERVAL_MAX);
  });
});

describe('refreshDue', () => {
  it('claims and refreshes the feeds due, skips one another tick holds and the dead', async () => {
    const s = store();
    s.due.mockResolvedValue([
      feed,
      { ...feed, id: 'f-2', url: 'https://two.example/feed' },
      { ...feed, id: 'f-3', url: 'https://dead.example/feed', dead: true },
    ]);
    s.claim.mockImplementation(async (_uid: string, id: string) => id !== 'f-2');
    const fetch = vi.fn(ok(RSS(item('a', 1))));
    const report = await refreshDue({ store: s, fetch, now: () => NOW }, { uid: 'u1', limit: 10 });
    expect(s.due).toHaveBeenCalledWith(NOW, 10, 'u1');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ fetched: 1, added: 1, failed: 0, skipped: 1 });
  });
});
