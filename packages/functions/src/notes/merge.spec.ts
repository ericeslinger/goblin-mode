import { textHash } from '@mossgoblin/schema';
import { describe, expect, it, vi } from 'vitest';
import type { NoteState } from './history';
import { type MergeStore, mergeConflict } from './merge';

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

function store(kept: string[]) {
  return {
    keptBodies: vi.fn(async () => kept),
    writeMerged: vi.fn(async () => true),
  } satisfies MergeStore;
}

describe('mergeConflict', () => {
  it('merges a write made over text its writer had not seen', async () => {
    // Eric ticked apples offline, over S; Claude had added oats meanwhile.
    const s = store([CLAUDE, S]);
    const before = state(CLAUDE, { updatedBy: 'claude', deviceId: 'claude' });
    const after = state(ERIC, { baseHash: textHash(S) });
    expect(await mergeConflict(s, 'u1', 'n1', before, after)).toBe('merged');
    expect(s.writeMerged).toHaveBeenCalledWith(
      'u1',
      'n1',
      ERIC,
      'List\n- [x] apples\n- [ ] kale\n- [ ] oats',
    );
  });

  it('leaves a write made over the text it replaced, or with no base', async () => {
    const s = store([S]);
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

  it('does not guess when the shared text is not in history', async () => {
    const s = store(['something else']);
    expect(
      await mergeConflict(s, 'u1', 'n1', state(CLAUDE), state(ERIC, { baseHash: textHash(S) })),
    ).toBe('no-base');
    expect(s.writeMerged).not.toHaveBeenCalled();
  });

  it('writes nothing when the write already holds the other side', async () => {
    const s = store([S]);
    const both = 'List\n- [x] apples\n- [ ] kale\n- [ ] oats';
    expect(
      await mergeConflict(s, 'u1', 'n1', state(CLAUDE), state(both, { baseHash: textHash(S) })),
    ).toBe('clean');
    expect(s.writeMerged).not.toHaveBeenCalled();
  });
});
