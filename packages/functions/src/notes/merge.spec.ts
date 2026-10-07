import { textHash } from '@mossgoblin/schema';
import { describe, expect, it, vi } from 'vitest';
import type { NoteState } from './history';
import { type CurrentNote, type MergeStore, mergeConflict } from './merge';

const S = 'List\n- [ ] apples\n- [ ] kale';
const CLAUDE = 'List\n- [ ] apples\n- [ ] kale\n- [ ] oats';
const ERIC = 'List\n- [x] apples\n- [ ] kale';

const state = (body: string, over: Partial<NoteState> = {}): NoteState => ({
  body,
  title: 'List',
  updatedBy: 'user',
  deviceId: 'phone',
  ...over,
});

/** A store over one note: `current` is what a transaction reads. */
function store(kept: string[], current: CurrentNote) {
  const s = {
    current,
    keptBodies: vi.fn(async () => kept),
    writeMerged: vi.fn(
      async (_uid: string, _id: string, decide: Parameters<MergeStore['writeMerged']>[2]) => {
        const write = decide(s.current);
        if (!write) return false;
        s.current = {
          body: write.body,
          baseHash: textHash(write.over),
          deviceId: 'merge',
          updatedBy: 'user',
        };
        return true;
      },
    ),
  } satisfies MergeStore & { current: CurrentNote };
  return s;
}

const now = (body: string, over: Partial<CurrentNote> = {}): CurrentNote => ({
  body,
  deviceId: 'phone',
  updatedBy: 'user',
  ...over,
});

describe('mergeConflict', () => {
  it('merges a write made over text its writer had not seen', async () => {
    // Eric ticked apples offline, over S; Claude had added oats meanwhile.
    const s = store([CLAUDE, S], now(ERIC, { baseHash: textHash(S) }));
    const before = state(CLAUDE, { updatedBy: 'claude', deviceId: 'claude' });
    const after = state(ERIC, { baseHash: textHash(S) });
    expect(await mergeConflict(s, 'u1', 'n1', before, after)).toBe('merged');
    expect(s.current.body).toBe('List\n- [x] apples\n- [ ] kale\n- [ ] oats');
    expect(s.current.baseHash).toBe(textHash(ERIC));
  });

  it('carries the merge onto a save made since, so it is not lost', async () => {
    // The phone comes back with two queued saves; the second is stored
    // before the first one's trigger runs.
    const W1 = ERIC;
    const W2 = `${ERIC}\n- [ ] bread`;
    const s = store([CLAUDE, S], now(W2, { baseHash: textHash(W1) }));
    const before = state(CLAUDE, { updatedBy: 'claude', deviceId: 'claude' });
    expect(await mergeConflict(s, 'u1', 'n1', before, state(W1, { baseHash: textHash(S) }))).toBe(
      'merged',
    );
    expect(s.current.body).toBe('List\n- [x] apples\n- [ ] kale\n- [ ] bread\n- [ ] oats');
    // The second save's own trigger has nothing more to do.
    expect(
      await mergeConflict(s, 'u1', 'n1', state(W1), state(W2, { baseHash: textHash(W1) })),
    ).toBe('clean');
  });

  it('merges two devices from the text both started from, keeping both', async () => {
    // Phone: B0 -> S1 -> S2. Laptop, offline: B0 -> L1, stored between.
    const B0 = 'Plan';
    const S1 = 'Plan\nphone one';
    const L1 = 'Plan\nlaptop';
    const S2 = 'Plan\nphone one\nphone two';
    const kept = [L1, S1, B0];
    const s = store(kept, now(S2, { baseHash: textHash(S1) }));
    const before = state(L1, { deviceId: 'laptop', baseHash: textHash(B0) });
    expect(await mergeConflict(s, 'u1', 'n1', before, state(S2, { baseHash: textHash(S1) }))).toBe(
      'merged',
    );
    expect(s.current.body).toBe('Plan\nphone one\nphone two\nlaptop');
    // The laptop's own trigger, late, finds the note moved on with it in.
    const late = await mergeConflict(
      s,
      'u1',
      'n1',
      state(S1, { baseHash: textHash(B0) }),
      state(L1, { deviceId: 'laptop', baseHash: textHash(B0) }),
    );
    expect(late).toBe('moved-on');
    expect(s.current.body).toBe('Plan\nphone one\nphone two\nlaptop');
  });

  it('leaves a write made over the text it replaced, or with no base', async () => {
    const s = store([S], now(ERIC));
    const before = state(CLAUDE);
    expect(
      await mergeConflict(s, 'u1', 'n1', before, state(ERIC, { baseHash: textHash(CLAUDE) })),
    ).toBe('clean');
    expect(await mergeConflict(s, 'u1', 'n1', before, state(ERIC, { baseHash: '' }))).toBe('clean');
    expect(await mergeConflict(s, 'u1', 'n1', before, state(ERIC))).toBe('clean');
    expect(await mergeConflict(s, 'u1', 'n1', undefined, state(ERIC, { baseHash: 'x' }))).toBe(
      'clean',
    );
    expect(s.keptBodies).not.toHaveBeenCalled();
  });

  it('does not guess when no shared text is in history', async () => {
    const s = store(['something else'], now(ERIC));
    expect(
      await mergeConflict(s, 'u1', 'n1', state(CLAUDE), state(ERIC, { baseHash: textHash(S) })),
    ).toBe('no-base');
    expect(s.writeMerged).not.toHaveBeenCalled();
  });

  it('leaves the note to a writer that had not built on this write', async () => {
    // Another device wrote over it without having seen it: its own
    // trigger merges.
    const s = store(
      [CLAUDE, S],
      now('List\nlaptop', { deviceId: 'laptop', baseHash: textHash(S) }),
    );
    expect(
      await mergeConflict(
        s,
        'u1',
        'n1',
        state(CLAUDE, { updatedBy: 'claude', deviceId: 'claude' }),
        state(ERIC, { baseHash: textHash(S) }),
      ),
    ).toBe('moved-on');
    expect(s.current.body).toBe('List\nlaptop');
  });
});
