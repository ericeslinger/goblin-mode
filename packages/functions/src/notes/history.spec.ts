import { HISTORY_INTERVAL_MS } from '@goblin/schema';
import { describe, expect, it, vi } from 'vitest';
import { type HistoryStore, type NoteState, recordHistory } from './history';

const t0 = 1_800_000_000_000;
const note = (body: string, over: Partial<NoteState> = {}): NoteState => ({
  body,
  title: body.split('\n')[0],
  updatedBy: 'user',
  deviceId: 'd1',
  updatedAt: t0,
  createdAt: t0,
  ...over,
});

function fakeStore(lastKept?: number) {
  return {
    lastKept: vi.fn(async () => lastKept),
    keep: vi.fn(async () => undefined),
  } satisfies HistoryStore;
}

describe('recordHistory', () => {
  it('keeps nothing for a new note', async () => {
    const store = fakeStore();
    expect(await recordHistory(store, 'u1', 'n1', undefined, note('hi'), t0)).toBeNull();
    expect(store.keep).not.toHaveBeenCalled();
  });

  it('keeps the version another device wrote over, as it was', async () => {
    const store = fakeStore();
    const before = note('mine', { title: 'Mine', updatedAt: t0 + 5 });
    await recordHistory(store, 'u1', 'n1', before, note('theirs', { deviceId: 'd2' }), t0 + 9);
    expect(store.keep).toHaveBeenCalledWith('u1', 'n1', {
      body: 'mine',
      title: 'Mine',
      updatedBy: 'user',
      deviceId: 'd1',
      updatedAt: t0 + 5,
      reason: 'device',
    });
  });

  it('times the interval from the last kept version, or from creation', async () => {
    const fresh = fakeStore();
    const edit = [note('a'), note('ab')] as const;
    expect(
      await recordHistory(fresh, 'u1', 'n1', ...edit, t0 + HISTORY_INTERVAL_MS - 1),
    ).toBeNull();
    expect(await recordHistory(fresh, 'u1', 'n1', ...edit, t0 + HISTORY_INTERVAL_MS)).toBe(
      'interval',
    );
    const kept = fakeStore(t0 + HISTORY_INTERVAL_MS);
    expect(
      await recordHistory(kept, 'u1', 'n1', ...edit, t0 + HISTORY_INTERVAL_MS * 2 - 1),
    ).toBeNull();
  });

  it('keeps a deleted note', async () => {
    const store = fakeStore();
    expect(await recordHistory(store, 'u1', 'n1', note('gone'), undefined, t0)).toBe('deleted');
  });
});
