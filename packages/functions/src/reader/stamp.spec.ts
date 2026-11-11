import { describe, expect, it, vi } from 'vitest';
import {
  STAMP_SETTLE_MS,
  type Stamp,
  type StampStore,
  kindChanged,
  restamp,
  stampItems,
} from './stamp';

const NOW = Date.parse('2026-11-11T12:00:00Z');

/** One gardener's feeds and items in memory, ids sorted as Firestore's document ids are. */
function memory(
  feeds: Record<string, boolean>,
  items: Record<string, { feedId: string; podcast?: boolean }>,
) {
  let marker = false;
  let progress: { firstAt?: number; cursor?: string } = {};
  const sorted = () => Object.keys(items).sort();
  const after = (ids: string[], from: string | undefined) =>
    from === undefined ? ids : ids.filter((id) => id > from);
  const store = {
    isShow: vi.fn(async (_uid: string, feedId: string) => feeds[feedId] === true),
    feedPage: vi.fn(async (_uid: string, feedId: string, from: string | undefined, size: number) =>
      after(sorted(), from)
        .filter((id) => items[id].feedId === feedId)
        .slice(0, size)
        .map((id) => ({ id, podcast: items[id].podcast })),
    ),
    write: vi.fn(async (_uid: string, stamps: Stamp[]) => {
      let n = 0;
      for (const s of stamps) {
        if (!items[s.id]) continue;
        items[s.id].podcast = s.podcast;
        n++;
      }
      return n;
    }),
    marked: vi.fn(async () => marker),
    progress: vi.fn(async () => ({ ...progress })),
    saveProgress: vi.fn(async (_uid: string, p: { firstAt?: number; cursor?: string }) => {
      progress = { ...progress, ...p };
    }),
    kinds: vi.fn(async () => new Map(Object.entries(feeds))),
    anyItem: vi.fn(async () => Object.keys(items).length > 0),
    page: vi.fn(async (_uid: string, from: string | undefined, size: number) =>
      after(sorted(), from)
        .slice(0, size)
        .map((id) => ({ id, feedId: items[id].feedId, podcast: items[id].podcast })),
    ),
    finish: vi.fn(async () => {
      marker = true;
      progress = {};
    }),
  } satisfies StampStore;
  return { store, items, feeds, isMarked: () => marker, progress: () => progress };
}

/** Items i00..iNN, alternating between a Reader feed and a show. */
function many(n: number) {
  const items: Record<string, { feedId: string; podcast?: boolean }> = {};
  for (let i = 0; i < n; i++)
    items[`i${String(i).padStart(2, '0')}`] = { feedId: i % 2 ? 'show' : 'blog' };
  return items;
}

describe('kindChanged (#248)', () => {
  it('restamps a feed made or moved, never one removed or written as it was', () => {
    expect(kindChanged(undefined, { exists: true, kind: 'podcast' })).toBe(true);
    expect(kindChanged({ exists: false }, { exists: true })).toBe(true);
    expect(kindChanged({ exists: true }, { exists: true, kind: 'podcast' })).toBe(true);
    expect(kindChanged({ exists: true, kind: 'podcast' }, { exists: true })).toBe(true);
    // The fetcher's own writes leave the kind as it was.
    expect(kindChanged({ exists: true, kind: 'podcast' }, { exists: true, kind: 'podcast' })).toBe(
      false,
    );
    expect(kindChanged({ exists: true }, { exists: true })).toBe(false);
    // A removal is feedRemoved's.
    expect(kindChanged({ exists: true, kind: 'podcast' }, { exists: false })).toBe(false);
  });
});

describe('restamp (#248)', () => {
  it('stamps every item of the feed with its kind now, in pages, and twice is once', async () => {
    const m = memory(
      { show: true, blog: false },
      {
        a: { feedId: 'show' },
        b: { feedId: 'show', podcast: false },
        c: { feedId: 'show', podcast: true },
        d: { feedId: 'blog' },
      },
    );
    expect(await restamp(m.store, 'u1', 'show', 2)).toBe(2);
    expect(m.items).toMatchObject({
      a: { podcast: true },
      b: { podcast: true },
      c: { podcast: true },
    });
    // Another feed's items are not touched.
    expect(m.items['d']).not.toHaveProperty('podcast');
    m.store.write.mockClear();
    expect(await restamp(m.store, 'u1', 'show', 2)).toBe(0);
    expect(m.store.write).not.toHaveBeenCalled();
  });

  it('stamps a gone feed’s saved items the Reader’s', async () => {
    const m = memory({}, { a: { feedId: 'show', podcast: true } });
    await restamp(m.store, 'u1', 'show');
    expect(m.items['a'].podcast).toBe(false);
  });

  it('goes round again when the feed moved during the run', async () => {
    const m = memory({ show: true }, { a: { feedId: 'show' }, b: { feedId: 'show' } });
    // Moved back to the Reader just as the first round ended.
    m.store.isShow.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    m.feeds['show'] = false;
    await restamp(m.store, 'u1', 'show');
    expect(m.items).toMatchObject({ a: { podcast: false }, b: { podcast: false } });
  });
});

describe('stampItems, the backfill (#248)', () => {
  it('marks a gardener with no feed and no item at once, with no work', async () => {
    const m = memory({}, {});
    expect(await stampItems(m.store, 'u1', NOW)).toEqual({ stamped: 0, done: true, more: false });
    expect(m.isMarked()).toBe(true);
    expect(m.store.page).not.toHaveBeenCalled();
    expect(m.store.write).not.toHaveBeenCalled();
  });

  it('waits after the first call before it starts, so a look on the old code has ended', async () => {
    const m = memory({ blog: false }, many(3));
    expect(await stampItems(m.store, 'u1', NOW)).toEqual({ stamped: 0, done: false, more: false });
    expect(m.progress()).toEqual({ firstAt: NOW });
    expect(await stampItems(m.store, 'u1', NOW + STAMP_SETTLE_MS - 1)).toMatchObject({
      done: false,
      more: false,
    });
    expect(m.store.page).not.toHaveBeenCalled();
    expect(m.isMarked()).toBe(false);
  });

  it('stamps every item by its feed, a few pages a call, going on from where it stopped', async () => {
    const m = memory({ blog: false, show: true }, many(6));
    // Saved episode of a show since unfollowed: the Reader's.
    m.items['i06'] = { feedId: 'gone' };
    await stampItems(m.store, 'u1', NOW);
    const later = NOW + STAMP_SETTLE_MS;
    const opts = { pageSize: 2, pages: 2 };
    expect(await stampItems(m.store, 'u1', later, opts)).toEqual({
      stamped: 4,
      done: false,
      more: true,
    });
    expect(m.progress().cursor).toBe('i03');
    expect(m.isMarked()).toBe(false);
    // The next call resumes after i03, and the last short page ends the pass.
    expect(await stampItems(m.store, 'u1', later + 1, opts)).toEqual({
      stamped: 3,
      done: true,
      more: false,
    });
    expect(m.store.page.mock.calls.map((c) => c[1])).toEqual([undefined, 'i01', 'i03', 'i05']);
    for (const [id, it] of Object.entries(m.items)) {
      expect(it.podcast, id).toBe(it.feedId === 'show');
    }
    expect(m.isMarked()).toBe(true);
    expect(m.progress()).toEqual({});
  });

  it('is idempotent: stamped items are not written again, and a marked gardener costs one read', async () => {
    const items = many(4);
    items['i00'].podcast = false;
    items['i01'].podcast = true;
    const m = memory({ blog: false, show: true }, items);
    m.store.saveProgress('u1', { firstAt: NOW - STAMP_SETTLE_MS });
    expect((await stampItems(m.store, 'u1', NOW)).stamped).toBe(2);
    expect(m.store.write.mock.calls[0][1].map((s) => s.id)).toEqual(['i02', 'i03']);
    m.store.kinds.mockClear();
    expect(await stampItems(m.store, 'u1', NOW)).toEqual({ stamped: 0, done: true, more: false });
    expect(m.store.kinds).not.toHaveBeenCalled();
    expect(m.store.write).toHaveBeenCalledTimes(1);
  });

  it('restamps a feed moved while the run was stamping', async () => {
    const m = memory({ blog: false, show: true }, many(4));
    m.store.saveProgress('u1', { firstAt: NOW - STAMP_SETTLE_MS });
    // Read as a show at the start; moved to the Reader before the end.
    m.store.kinds.mockImplementationOnce(
      async () =>
        new Map([
          ['blog', false],
          ['show', true],
        ]),
    );
    m.store.kinds.mockImplementationOnce(
      async () =>
        new Map([
          ['blog', false],
          ['show', false],
        ]),
    );
    m.feeds['show'] = false;
    await stampItems(m.store, 'u1', NOW);
    expect(Object.values(m.items).map((i) => i.podcast)).toEqual([false, false, false, false]);
    expect(m.isMarked()).toBe(true);
  });
});
