import { TRASH_MS } from '@mossgoblin/schema';
import { describe, expect, it, vi } from 'vitest';
import { type Reread, type TrashStore, type Trashed, dueAt, sweepTrash } from './trash';

const now = Date.parse('2026-12-09T12:00:00Z');
const day = 24 * 60 * 60_000;

/**
 * A store over `trash`, answering the query as Firestore would. Read
 * again, a note was last written when it was deleted, unless `later`
 * says the server wrote it since; one in `restored` has no stamp now.
 */
function fakeStore(trash: Trashed[], restored: string[] = [], later: Record<string, number> = {}) {
  const found = new Map(trash.map((t) => [t.path, t]));
  return {
    due: vi.fn(async (cutoff: number, limit: number) =>
      trash
        .filter((t) => t.deletedAt <= cutoff)
        .sort((a, b) => a.deletedAt - b.deletedAt)
        .slice(0, limit),
    ),
    read: vi.fn(async (path: string): Promise<Reread | undefined> => {
      const t = found.get(path);
      if (!t) return undefined;
      const updateTime = later[path] ?? t.deletedAt;
      return restored.includes(path) ? { updateTime } : { deletedAt: t.deletedAt, updateTime };
    }),
    remove: vi.fn(async (_path: string) => undefined),
  } satisfies TrashStore;
}

describe('sweepTrash (#217)', () => {
  it('removes only the notes in Trash 30 days or more', async () => {
    const store = fakeStore([
      { path: 'users/u1/notes/old', deletedAt: now - 31 * day },
      { path: 'users/u1/notes/just', deletedAt: now - TRASH_MS },
      { path: 'users/u1/notes/young', deletedAt: now - 29 * day },
      { path: 'users/u2/notes/new', deletedAt: now },
    ]);
    const report = await sweepTrash(store, now);
    expect(store.due).toHaveBeenCalledWith(now - TRASH_MS, 100);
    expect(store.remove.mock.calls.map(([p]) => p)).toEqual([
      'users/u1/notes/old',
      'users/u1/notes/just',
    ]);
    expect(report).toEqual({ due: 2, removed: 2, skipped: 0 });
  });

  it('is bounded per run, oldest first', async () => {
    const trash = Array.from({ length: 5 }, (_, i) => ({
      path: `users/u1/notes/n${i}`,
      deletedAt: now - (40 - i) * day,
    }));
    const store = fakeStore(trash);
    const report = await sweepTrash(store, now, 3);
    expect(store.remove.mock.calls.map(([p]) => p)).toEqual([
      'users/u1/notes/n0',
      'users/u1/notes/n1',
      'users/u1/notes/n2',
    ]);
    expect(report).toEqual({ due: 3, removed: 3, skipped: 0 });
  });

  it('never removes a young note a store hands back, and counts one restored meanwhile', async () => {
    const restored = { path: 'users/u1/notes/restored', deletedAt: now - 35 * day };
    const young = { path: 'users/u1/notes/young', deletedAt: now - day };
    const store = fakeStore([restored, young], [restored.path]);
    store.due.mockResolvedValueOnce([restored, young]);
    const report = await sweepTrash(store, now);
    expect(store.read.mock.calls.map(([p]) => p)).toEqual([restored.path]);
    expect(store.remove).not.toHaveBeenCalled();
    expect(report).toEqual({ due: 1, removed: 0, skipped: 1 });
  });

  it('trusts no device clock: a note the server wrote lately waits (review on #230)', async () => {
    // Stamped 40 days back by a device whose clock is a month slow, but
    // written by the server an hour ago; another written to 31 days on.
    const slow = { path: 'users/u1/notes/slow', deletedAt: now - 40 * day };
    const old = { path: 'users/u1/notes/old', deletedAt: now - 40 * day };
    const store = fakeStore([slow, old], [], {
      [slow.path]: now - 60 * 60_000,
      [old.path]: now - 31 * day,
    });
    const report = await sweepTrash(store, now);
    expect(store.remove.mock.calls.map(([p]) => p)).toEqual([old.path]);
    expect(report).toEqual({ due: 2, removed: 1, skipped: 1 });
  });

  it('calls a note due exactly 30 days after it was deleted', () => {
    expect(dueAt(now - TRASH_MS, now)).toBe(true);
    expect(dueAt(now - TRASH_MS + 1, now)).toBe(false);
  });
});
