import { HISTORY_INTERVAL_MS } from '@mossgoblin/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  type HistoryStore,
  KEPT_MARGIN_MS,
  KeptTimes,
  type NoteState,
  recordHistory,
} from './history';

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
    expect(await recordHistory(store, 'u1', 'n1', 'e1', undefined, note('hi'), t0)).toBeNull();
    expect(store.keep).not.toHaveBeenCalled();
  });

  it('keeps the version another device wrote over, as it was', async () => {
    const store = fakeStore();
    const before = note('mine', { title: 'Mine', updatedAt: t0 + 5 });
    await recordHistory(
      store,
      'u1',
      'n1',
      'e1',
      before,
      note('theirs', { deviceId: 'd2' }),
      t0 + 9,
    );
    expect(store.keep).toHaveBeenCalledWith('u1', 'n1', 'e1', {
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
      await recordHistory(fresh, 'u1', 'n1', 'e1', ...edit, t0 + HISTORY_INTERVAL_MS - 1),
    ).toBeNull();
    expect(await recordHistory(fresh, 'u1', 'n1', 'e1', ...edit, t0 + HISTORY_INTERVAL_MS)).toBe(
      'interval',
    );
    const kept = fakeStore(t0 + HISTORY_INTERVAL_MS);
    expect(
      await recordHistory(kept, 'u1', 'n1', 'e1', ...edit, t0 + HISTORY_INTERVAL_MS * 2 - 1),
    ).toBeNull();
  });

  it('reads the last kept version only when the interval decides', async () => {
    const store = fakeStore();
    await recordHistory(
      store,
      'u1',
      'n1',
      'e1',
      note('mine'),
      note('theirs', { deviceId: 'd2' }),
      t0,
    );
    await recordHistory(store, 'u1', 'n1', 'e2', note('same'), note('same'), t0);
    expect(store.lastKept).not.toHaveBeenCalled();
    await recordHistory(store, 'u1', 'n1', 'e3', note('a'), note('ab'), t0);
    expect(store.lastKept).toHaveBeenCalledTimes(1);
  });

  it('keeps a deleted note', async () => {
    const store = fakeStore();
    expect(await recordHistory(store, 'u1', 'n1', 'e1', note('gone'), undefined, t0)).toBe(
      'deleted',
    );
  });

  it('keeps nothing when the sweep removes a note from Trash (#217)', async () => {
    const store = fakeStore();
    const trashed = note('gone', { deletedAt: t0 });
    expect(await recordHistory(store, 'u1', 'n1', 'e1', trashed, undefined, t0)).toBeNull();
    expect(store.keep).not.toHaveBeenCalled();
    // A write to it while in Trash keeps a version like any other.
    expect(
      await recordHistory(store, 'u1', 'n1', 'e3', trashed, note('x', { deviceId: 'd2' }), t0),
    ).toBe('device');
  });
});

describe('recordHistory with what the instance knows (2026-11-22)', () => {
  const I = HISTORY_INTERVAL_MS;
  /** A History that keeps what it is given, `savedAt` the trigger's time. */
  function history(times: number[] = []) {
    const store = {
      lastKept: vi.fn(async () => (times.length ? Math.max(...times) : undefined)),
      keep: vi.fn(async () => undefined),
    } satisfies HistoryStore;
    return { store, times };
  }
  /** One write, its time `at`; a kept version is saved at `at`. */
  async function write(
    h: ReturnType<typeof history>,
    kept: KeptTimes | undefined,
    before: NoteState,
    after: NoteState | undefined,
    at: number,
  ) {
    const reason = await recordHistory(h.store, 'u1', 'n1', `e${at}`, before, after, at, kept);
    if (reason) h.times.push(at);
    return reason;
  }

  it('a typing save on one device inside the interval reads nothing', async () => {
    const h = history();
    const kept = new KeptTimes();
    // The first save on this instance reads, once.
    expect(await write(h, kept, note('a'), note('ab'), t0 + 1000)).toBeNull();
    expect(h.store.lastKept).toHaveBeenCalledTimes(1);
    for (let i = 2; i < 50; i++) {
      const at = t0 + i * 3000;
      expect(await write(h, kept, note('a'.repeat(i)), note('a'.repeat(i + 1)), at)).toBeNull();
    }
    expect(h.store.lastKept).toHaveBeenCalledTimes(1);
    // A version kept: the saves after it read nothing either.
    expect(await write(h, kept, note('x'), note('xy', { deviceId: 'd2' }), t0 + 200_000)).toBe(
      'device',
    );
    const reads = h.store.lastKept.mock.calls.length;
    const d2 = { deviceId: 'd2' };
    expect(await write(h, kept, note('xy', d2), note('xyz', d2), t0 + 203_000)).toBeNull();
    expect(h.store.lastKept).toHaveBeenCalledTimes(reads);
  });

  it('keeps what it kept before: the interval, an author, a device, a deletion', async () => {
    // The same writes, with and without what an instance knows.
    const run = async (kept: KeptTimes | undefined) => {
      const h = history();
      const out: (string | null)[] = [];
      const claude = { updatedBy: 'claude' as const };
      const steps: [NoteState, NoteState | undefined, number][] = [];
      for (let i = 1; i <= 60; i++) {
        steps.push([note(`v${i}`), note(`v${i + 1}`), t0 + i * 20_000]);
      }
      steps.push([note('v61'), note('c1', claude), t0 + 1_300_000]);
      steps.push([note('c1', claude), note('c2', claude), t0 + 1_301_000]);
      steps.push([note('c2', claude), note('m1'), t0 + 1_302_000]);
      steps.push([note('m1'), note('m2', { deviceId: 'd2' }), t0 + 1_303_000]);
      for (let i = 0; i < 40; i++) {
        steps.push([note(`m${i + 2}`), note(`m${i + 3}`), t0 + 1_304_000 + i * 30_000]);
      }
      steps.push([note('m42'), undefined, t0 + 3_000_000]);
      for (const [b, a, at] of steps) out.push(await write(h, kept, b, a, at));
      return { out, reads: h.store.lastKept.mock.calls.length };
    };
    const without = await run(undefined);
    const known = await run(new KeptTimes());
    expect(known.out).toEqual(without.out);
    expect(without.out.filter((r) => r === 'interval').length).toBeGreaterThan(2);
    expect(without.out).toContain('author');
    expect(without.out).toContain('device');
    expect(without.out).toContain('deleted');
    // Nearly every save read before; now about one a kept version.
    expect(without.reads).toBeGreaterThan(90);
    expect(known.reads).toBeLessThan(10);
  });

  it('reads when what it knows cannot rule the interval out', async () => {
    const kept = new KeptTimes();
    const h = history();
    expect(await write(h, kept, note('a'), note('ab', { deviceId: 'd2' }), t0 + 1000)).toBe(
      'device',
    );
    const d2 = { deviceId: 'd2' };
    // Another instance kept one since: this one's floor is older, so the
    // interval is read, and the newer version keeps it from keeping.
    h.times.push(t0 + I);
    expect(await write(h, kept, note('ab', d2), note('abc', d2), t0 + 1000 + I)).toBeNull();
    expect(h.store.lastKept).toHaveBeenCalledTimes(1);
    expect(kept.floor('u1', 'n1', t0)).toBe(t0 + I);
    // Its kept time is taken a little early, for clocks.
    kept.kept('u1', 'n2', t0 + 5000);
    expect(kept.floor('u1', 'n2', undefined)).toBe(t0 + 5000 - KEPT_MARGIN_MS);
  });

  it('trusts a time known from createdAt only while the note still has it', async () => {
    const kept = new KeptTimes();
    kept.read('u1', 'n1', undefined, t0, t0 + 5000);
    expect(kept.floor('u1', 'n1', t0)).toBe(t0);
    // Made again (a restore of an older copy): not known.
    expect(kept.floor('u1', 'n1', t0 - I)).toBeUndefined();
    // A kept version stands whatever createdAt says.
    kept.read('u1', 'n1', t0 + 100, t0, t0 + 6000);
    expect(kept.floor('u1', 'n1', t0 - I)).toBe(t0 + 100);
  });

  it('forgets the oldest note first past its bound', () => {
    const kept = new KeptTimes(2);
    kept.kept('u1', 'a', t0 + KEPT_MARGIN_MS);
    kept.kept('u1', 'b', t0 + KEPT_MARGIN_MS);
    kept.kept('u1', 'c', t0 + KEPT_MARGIN_MS);
    expect(kept.floor('u1', 'a', undefined)).toBeUndefined();
    expect(kept.floor('u1', 'c', undefined)).toBe(t0);
  });
});
