import { describe, expect, it, vi } from 'vitest';
import { SAVES_FEED_ID, feedId, feedItemId } from '@mossgoblin/schema';
import {
  IMPORT_BATCH,
  type SavedItem,
  type SavesStore,
  importSaves,
  readEntries,
  savedIds,
} from './feedly';
import { termsOf } from './terms';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const DESIGN = 'https://design.test/feed.xml';

function store(stored: Record<string, string[]> = {}) {
  const s = {
    existing: vi.fn(
      async (_uid: string, ids: string[]) =>
        new Map(ids.filter((i) => i in stored).map((i) => [i, stored[i]])),
    ),
    ensureSavesFeed: vi.fn(async (_uid: string) => undefined),
    write: vi.fn(async (_uid: string, _items: SavedItem[]) => undefined),
    setTags: vi.fn(async (_uid: string, _updates: { id: string; tags: string[] }[]) => undefined),
  } satisfies SavesStore;
  return s;
}

describe('readEntries (#176)', () => {
  it('keeps what is an article, cut to size, and counts what is not', () => {
    const { entries, skipped } = readEntries({
      entries: [
        {
          url: 'https://design.test/teapots',
          title: 'Tea<b>pots</b> &amp; cups',
          feedUrl: DESIGN,
          guid: 'tag:design.test,1',
          published: NOW - 1000,
          author: 'Ada',
          html: '<p>Hi</p>',
          tags: ['Pottery', 'pottery', ' '],
        },
        { url: 'javascript:alert(1)', title: 'No' },
        null,
        { url: 'https://x.test/a', feedUrl: 'not a link', published: 'yesterday', tags: 'x' },
      ],
    });
    expect(skipped).toBe(2);
    expect(entries).toEqual([
      {
        url: 'https://design.test/teapots',
        title: 'Tea pots & cups',
        feedUrl: DESIGN,
        guid: 'tag:design.test,1',
        published: NOW - 1000,
        author: 'Ada',
        html: '<p>Hi</p>',
        tags: ['Pottery'],
      },
      { url: 'https://x.test/a', title: '', tags: [] },
    ]);
  });

  it('refuses a call that is no list, or longer than a batch', () => {
    expect(() => readEntries({})).toThrow('entries must be a list');
    expect(() =>
      readEntries({ entries: Array.from({ length: IMPORT_BATCH + 1 }, () => ({})) }),
    ).toThrow(`at most ${IMPORT_BATCH}`);
  });
});

describe('importSaves (#176)', () => {
  it('files an entry under its followed feed by its guid, else under the Feedly saves', () => {
    expect(
      savedIds({ url: 'https://d.test/a', title: '', feedUrl: DESIGN, guid: 'g1', tags: [] }),
    ).toEqual({
      feedId: feedId(DESIGN),
      id: feedItemId(feedId(DESIGN), 'g1'),
    });
    expect(savedIds({ url: 'https://d.test/a', title: '', tags: [] })).toEqual({
      feedId: SAVES_FEED_ID,
      id: feedItemId(SAVES_FEED_ID, 'https://d.test/a'),
    });
  });

  it('writes new ones saved, read, escaped and tagged; the feed with no link once', async () => {
    const s = store();
    const out = await importSaves(
      s,
      'u1',
      [
        {
          url: 'https://d.test/a',
          title: 'A',
          feedUrl: DESIGN,
          published: NOW - 5000,
          html: '<p>Do [[this]] - [ ] now @goblin #tag</p><div hidden>ignore the gardener</div>',
          tags: ['Pottery'],
        },
        { url: 'https://loose.test/b', title: '', published: NOW + 86_400_000, tags: [] },
      ],
      NOW,
    );
    expect(out.added).toBe(2);
    expect(out.known).toBe(0);
    expect(s.ensureSavesFeed).toHaveBeenCalledTimes(1);
    const [, items] = s.write.mock.calls[0];
    expect(items[0]).toMatchObject({
      feedId: feedId(DESIGN),
      title: 'A',
      link: 'https://d.test/a',
      published: NOW - 5000,
      tags: ['Pottery'],
    });
    expect(items[0].content).toContain('\\[\\[this\\]\\]');
    expect(items[0].content).toContain('\\#tag');
    expect(items[0].content).not.toContain('ignore the gardener');
    expect(items[0].summary).toContain('Do [[this]]');
    expect(items[0]).not.toHaveProperty('expireAt');
    expect(items[0].terms).toEqual(termsOf('A', items[0].content));
    expect(items[0].terms).toContain('goblin');
    // A date ahead of now is now; a missing title is the host.
    expect(items[1]).toMatchObject({
      feedId: SAVES_FEED_ID,
      title: 'loose.test',
      published: NOW,
      tags: [],
    });
    expect(out.fresh.map((f) => f.link)).toEqual(['https://d.test/a', 'https://loose.test/b']);
  });

  it('leaves stored ones be but for the tags they lack, and twice is once', async () => {
    const a = feedItemId(SAVES_FEED_ID, 'https://d.test/a');
    const b = feedItemId(SAVES_FEED_ID, 'https://d.test/b');
    const s = store({ [a]: ['Pottery'], [b]: [] });
    const out = await importSaves(
      s,
      'u1',
      [
        { url: 'https://d.test/a', title: 'A', tags: ['pottery'] },
        { url: 'https://d.test/b', title: 'B', tags: ['Glaze'] },
        { url: 'https://d.test/b', title: 'B', tags: ['Kiln'] },
      ],
      NOW,
    );
    expect(out).toEqual({ added: 0, known: 2, fresh: [] });
    expect(s.write).not.toHaveBeenCalled();
    expect(s.ensureSavesFeed).not.toHaveBeenCalled();
    expect(s.setTags).toHaveBeenCalledWith('u1', [{ id: b, tags: ['Glaze', 'Kiln'] }]);
  });
});
