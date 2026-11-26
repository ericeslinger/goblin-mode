import { describe, expect, it, vi } from 'vitest';
import {
  type ShareStore,
  type ShareSweepStore,
  forgetDeletedShare,
  SHARE_SWEEP_PAGE,
  STRANGER_SHARES_PER_RUN,
  stopSharesOnWrite,
  sweepShares,
} from './share-stop';

const A = 'AbCdEfGhIjKlMnOpQrStUvWxYz012-_9';
const B = 'ZZCdEfGhIjKlMnOpQrStUvWxYz012-_9';

function store(shares: Record<string, { owner: string; noteId: string }>) {
  const s = {
    removed: [] as string[],
    forgot: [] as string[],
    read: vi.fn(async (id: string) => shares[id]),
    remove: vi.fn(async (id: string) => void s.removed.push(id)),
    forget: vi.fn(
      async (_uid: string, noteId: string, id: string) => void s.forgot.push(`${noteId}:${id}`),
    ),
  } satisfies ShareStore & { removed: string[]; forgot: string[] };
  return s;
}

const note = (more: Record<string, unknown> = {}) => ({ body: 'x', ...more });

describe('stopSharesOnWrite (2026-11-26)', () => {
  it('stops a note’s share when it goes to Trash, and takes the id off it', async () => {
    const s = store({ [A]: { owner: 'u1', noteId: 'n1' } });
    const removed = await stopSharesOnWrite(
      s,
      'u1',
      'n1',
      note({ shareId: A }),
      note({ shareId: A, deletedAt: { seconds: 1 } }),
    );
    expect(removed).toEqual([A]);
    expect(s.forgot).toEqual([`n1:${A}`]);
  });

  it('stops it when the note is deleted', async () => {
    const s = store({ [A]: { owner: 'u1', noteId: 'n1' } });
    expect(await stopSharesOnWrite(s, 'u1', 'n1', note({ shareId: A }), undefined)).toEqual([A]);
    expect(s.forgot).toEqual([]);
  });

  it('stops the old share when the note names another or none', async () => {
    const s = store({ [A]: { owner: 'u1', noteId: 'n1' }, [B]: { owner: 'u1', noteId: 'n1' } });
    expect(
      await stopSharesOnWrite(s, 'u1', 'n1', note({ shareId: A }), note({ shareId: B })),
    ).toEqual([A]);
    expect(await stopSharesOnWrite(s, 'u1', 'n1', note({ shareId: B }), note())).toEqual([B]);
  });

  it('leaves a share alone on an edit, an archive, or a new share', async () => {
    const s = store({ [A]: { owner: 'u1', noteId: 'n1' } });
    for (const [before, after] of [
      [note({ shareId: A }), note({ shareId: A, body: 'y' })],
      [note({ shareId: A }), note({ shareId: A, archived: true })],
      [note(), note({ shareId: A })],
      [undefined, note({ shareId: A })],
    ] as const) {
      expect(await stopSharesOnWrite(s, 'u1', 'n1', before, after)).toEqual([]);
    }
    expect(s.read).not.toHaveBeenCalled();
  });

  it('never removes a share of another owner or note', async () => {
    const s = store({ [A]: { owner: 'u2', noteId: 'n1' }, [B]: { owner: 'u1', noteId: 'n9' } });
    expect(await stopSharesOnWrite(s, 'u1', 'n1', note({ shareId: A }), undefined)).toEqual([]);
    expect(await stopSharesOnWrite(s, 'u1', 'n1', note({ shareId: B }), note())).toEqual([]);
    expect(s.removed).toEqual([]);
  });

  it('takes no notice of a value that is not a share id', async () => {
    const s = store({});
    expect(await stopSharesOnWrite(s, 'u1', 'n1', note({ shareId: '../x' }), undefined)).toEqual(
      [],
    );
    expect(s.read).not.toHaveBeenCalled();
  });
});

describe('forgetDeletedShare (review of #343)', () => {
  it('takes the id off the note its document named', async () => {
    const s = store({});
    expect(await forgetDeletedShare(s, A, { owner: 'u1', noteId: 'n1' })).toBe(true);
    expect(s.forgot).toEqual([`n1:${A}`]);
  });

  it('does nothing for a document without an owner and note, or a path in them', async () => {
    const s = store({});
    expect(await forgetDeletedShare(s, A, undefined)).toBe(false);
    expect(await forgetDeletedShare(s, A, { owner: 'u1' })).toBe(false);
    expect(await forgetDeletedShare(s, A, { owner: 'u1/notes/x', noteId: 'n1' })).toBe(false);
    expect(await forgetDeletedShare(s, 'bad', { owner: 'u1', noteId: 'n1' })).toBe(false);
    expect(s.forgot).toEqual([]);
  });
});

describe('sweepShares, daily (review of #343)', () => {
  const id = (n: number) => `S${String(n).padStart(31, '0')}`;
  function sweep(
    shares: { id: string; owner?: unknown; noteId?: unknown }[],
    notes: Record<string, { shareId?: unknown; trashed: boolean }>,
  ) {
    const removed: string[] = [];
    const sorted = [...shares].sort((a, b) => (a.id < b.id ? -1 : 1));
    const s: ShareSweepStore = {
      page: async (owner, after, limit) =>
        sorted
          .filter((x) => owner === undefined || x.owner === owner)
          .filter((x) => after === undefined || x.id > after)
          .slice(0, limit),
      notOf: async (owner, limit) => sorted.filter((x) => x.owner !== owner).slice(0, limit),
      note: async (owner, noteId) => notes[`${owner}/${noteId}`],
      remove: async (x) => void removed.push(x),
    };
    return { s, removed };
  }

  it('keeps a share its note names, and removes one gone, trashed, or not named', async () => {
    const C = 'CCCdEfGhIjKlMnOpQrStUvWxYz012-_9';
    const D = 'DDDdEfGhIjKlMnOpQrStUvWxYz012-_9';
    const E = 'EEEdEfGhIjKlMnOpQrStUvWxYz012-_9';
    const { s, removed } = sweep(
      [
        { id: A, owner: 'u1', noteId: 'n1' },
        { id: B, owner: 'u1', noteId: 'n2' },
        { id: C, owner: 'u1', noteId: 'n3' },
        { id: D, owner: 'u1', noteId: 'n4' },
        { id: E, owner: 'u1/x', noteId: 'n5' },
      ],
      {
        'u1/n1': { shareId: A, trashed: false },
        'u1/n2': { shareId: B, trashed: true },
        'u1/n3': { shareId: undefined, trashed: false },
      },
    );
    // No owner set (a fork): every share is looked at.
    expect(await sweepShares(s, undefined)).toEqual({ looked: 5, removed: 4, strangers: 0 });
    expect(removed.sort()).toEqual([B, C, D, E].sort());
  });

  it('cannot be starved: pages through every one of the owner’s shares, whatever else there is', async () => {
    const junk = Array.from({ length: 3_000 }, (_, i) => ({
      id: id(i),
      owner: `stranger${i}`,
      noteId: 'x',
    }));
    // The owner's, sorting after all the junk, more than a page of them.
    const mine = Array.from({ length: SHARE_SWEEP_PAGE + 20 }, (_, i) => ({
      id: `Z${String(i).padStart(31, '0')}`,
      owner: 'u1',
      noteId: `n${i}`,
    }));
    const notes: Record<string, { shareId?: unknown; trashed: boolean }> = {};
    mine.forEach((m, i) => (notes[`u1/n${i}`] = { shareId: m.id, trashed: i === mine.length - 1 }));
    const { s, removed } = sweep([...junk, ...mine], notes);
    const report = await sweepShares(s, 'u1');
    expect(report.looked).toBe(mine.length);
    // The last of the owner's, in Trash, is found and removed.
    expect(removed).toContain(mine[mine.length - 1].id);
    // Other accounts' shares, never shown, go a bounded number a run.
    expect(report.strangers).toBe(STRANGER_SHARES_PER_RUN);
    expect(report.removed).toBe(1);
  });
});
