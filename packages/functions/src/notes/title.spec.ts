import { describe, expect, it, vi } from 'vitest';
import type { NoteState } from './history';
import { TITLE_CONTEXT_CHARS, type TitleStore, titleNote } from './title';

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
  return {
    // Stands for the keyed hash: the same title and text, the same hash.
    titleHash: vi.fn(async (_id: string, title: string, text: string) =>
      JSON.stringify([title, text]),
    ),
    setTitle: vi.fn(async () => written),
  } satisfies TitleStore;
}
const hashOf = (title: string, text = BODY) => JSON.stringify([title, text]);

describe('titleNote', () => {
  it('asks Claude when the note is settled, and writes the cleaned title for that settle', async () => {
    const store = fakeStore();
    const titler = vi.fn(async () => '"Bank loan call."');
    const outcome = await titleNote(store, titler, 'u1', 'n1', note(), note({ settledAt: 7 }));
    expect(outcome).toBe('written');
    expect(titler).toHaveBeenCalledWith(BODY);
    expect(store.setTitle).toHaveBeenCalledWith(
      'u1',
      'n1',
      7,
      'Bank loan call',
      hashOf('Bank loan call'),
    );
  });

  it('asks nothing when the model title there was made from the same text (2026-11-22)', async () => {
    const store = fakeStore();
    const titler = vi.fn(async () => 'Loan');
    const titled = {
      title: 'Bank loan call',
      titleSource: 'llm',
      titleHash: hashOf('Bank loan call'),
    };
    const outcome = await titleNote(
      store,
      titler,
      'u1',
      'n1',
      note({ ...titled, settledAt: 3 }),
      note({ ...titled, settledAt: 7 }),
    );
    expect(outcome).toBe('same');
    expect(titler).not.toHaveBeenCalled();
    expect(store.setTitle).not.toHaveBeenCalled();
  });

  it('asks again when the text a title is made from changed', async () => {
    const store = fakeStore();
    const titler = vi.fn(async () => 'Bank rates');
    const titled = {
      title: 'Bank loan call',
      titleSource: 'llm',
      titleHash: hashOf('Bank loan call'),
    };
    const body = `${BODY}\nand the rates`;
    const outcome = await titleNote(
      store,
      titler,
      'u1',
      'n1',
      note({ ...titled, settledAt: 3 }),
      note({ ...titled, body, settledAt: 7 }),
    );
    expect(outcome).toBe('written');
    expect(titler).toHaveBeenCalledWith(body);
    expect(store.setTitle).toHaveBeenCalledWith(
      'u1',
      'n1',
      7,
      'Bank rates',
      hashOf('Bank rates', body),
    );
  });

  it('a change past what the model sees asks nothing; one in it asks', async () => {
    const titler = vi.fn(async () => 'Long one');
    const long = 'word '.repeat(TITLE_CONTEXT_CHARS);
    const seen = long.slice(0, TITLE_CONTEXT_CHARS);
    const titled = { title: 'Long one', titleSource: 'llm', titleHash: hashOf('Long one', seen) };
    const settle = (body: string) =>
      titleNote(
        fakeStore(),
        titler,
        'u1',
        'n1',
        note({ settledAt: 3 }),
        note({ ...titled, body, settledAt: 7 }),
      );
    expect(await settle(`${long}\nan end`)).toBe('same');
    expect(titler).not.toHaveBeenCalled();
    expect(await settle(`a start\n${long}`)).toBe('written');
    expect(titler).toHaveBeenCalledWith(`a start\n${long}`.slice(0, TITLE_CONTEXT_CHARS));
  });

  it('asks again of a title the model did not make, or one written over since', async () => {
    const titler = vi.fn(async () => 'Bank loan call');
    const hash = hashOf('Bank loan call');
    const settle = (over: Partial<NoteState>) =>
      titleNote(
        fakeStore(),
        titler,
        'u1',
        'n1',
        note(),
        note({ settledAt: 7, titleHash: hash, ...over }),
      );
    // First words, put back by a restore: the hash is left over.
    expect(await settle({ title: 'call the bank about the', titleSource: 'words' })).toBe(
      'written',
    );
    // Claude named it through the tools (llm): another title than the hash's.
    expect(await settle({ title: 'Loan', titleSource: 'llm' })).toBe('written');
    // No hash (a title from before 2026-11-22).
    expect(
      await settle({ title: 'Bank loan call', titleSource: 'llm', titleHash: undefined }),
    ).toBe('written');
    expect(titler).toHaveBeenCalledTimes(3);
  });

  it('asks the model when the hash cannot be made, and writes the title without one', async () => {
    const store = fakeStore();
    store.titleHash.mockRejectedValue(new Error('no key'));
    const titler = vi.fn(async () => 'Bank loan call');
    const titled = {
      title: 'Bank loan call',
      titleSource: 'llm',
      titleHash: hashOf('Bank loan call'),
    };
    const log = vi.fn();
    expect(
      await titleNote(store, titler, 'u1', 'n1', note(), note({ ...titled, settledAt: 7 }), log),
    ).toBe('written');
    expect(titler).toHaveBeenCalledTimes(1);
    expect(store.setTitle).toHaveBeenCalledWith('u1', 'n1', 7, 'Bank loan call', undefined);
    expect(log).toHaveBeenCalledWith('title hash failed', expect.any(Error));
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
    // Typed by Eric, whatever hash is left on it.
    expect(
      await titleNote(
        store,
        titler,
        'u1',
        'n1',
        note(),
        note({ settledAt: 7, titleSource: 'user', title: 'Mine', titleHash: 'x' }),
      ),
    ).toBe('skipped');
    expect(titler).not.toHaveBeenCalled();
    expect(store.setTitle).not.toHaveBeenCalled();
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
