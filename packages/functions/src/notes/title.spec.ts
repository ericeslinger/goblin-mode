import { describe, expect, it, vi } from 'vitest';
import type { NoteState } from './history';
import { type TitleStore, titleNote } from './title';

const BODY = 'call the bank about the loan\nask about rates';
const note = (over: Partial<NoteState> = {}): NoteState => ({
  body: BODY,
  title: '',
  titleSource: 'words',
  updatedBy: 'user',
  deviceId: 'd1',
  ...over,
});

function fakeStore(written = true) {
  return { setTitle: vi.fn(async () => written) } satisfies TitleStore;
}

describe('titleNote', () => {
  it('asks Claude when the note is settled, and writes the cleaned title for that settle', async () => {
    const store = fakeStore();
    const titler = vi.fn(async () => '"Bank loan call."');
    const outcome = await titleNote(store, titler, 'u1', 'n1', note(), note({ settledAt: 7 }));
    expect(outcome).toBe('written');
    expect(titler).toHaveBeenCalledWith(BODY);
    expect(store.setTitle).toHaveBeenCalledWith('u1', 'n1', 7, 'Bank loan call');
  });

  it("skips writes that do not settle the note, and never touches Eric's own title", async () => {
    const titler = vi.fn(async () => 'x');
    const store = fakeStore();
    expect(await titleNote(store, titler, 'u1', 'n1', note(), note())).toBe('skipped');
    expect(
      await titleNote(store, titler, 'u1', 'n1', note({ settledAt: 7 }), note({ settledAt: 7 })),
    ).toBe('skipped');
    expect(
      await titleNote(
        store,
        titler,
        'u1',
        'n1',
        note(),
        note({ settledAt: 7, titleSource: 'user' }),
      ),
    ).toBe('skipped');
    expect(titler).not.toHaveBeenCalled();
  });

  it('is off without federation settings, and keeps the words title when Claude fails', async () => {
    const store = fakeStore();
    const settled = note({ settledAt: 7 });
    expect(await titleNote(store, null, 'u1', 'n1', undefined, settled)).toBe('off');
    const log = vi.fn();
    const failing = vi.fn(async () => Promise.reject(new Error('401')));
    expect(await titleNote(store, failing, 'u1', 'n1', undefined, settled, log)).toBe('failed');
    expect(log).toHaveBeenCalledWith('title request failed', expect.any(Error));
    expect(store.setTitle).not.toHaveBeenCalled();
  });

  it('reports a title that arrived after the note was settled again', async () => {
    const outcome = await titleNote(
      fakeStore(false),
      async () => 'Loan',
      'u1',
      'n1',
      undefined,
      note({ settledAt: 7 }),
    );
    expect(outcome).toBe('stale');
  });
});
