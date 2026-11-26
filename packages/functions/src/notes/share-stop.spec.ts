import { describe, expect, it, vi } from 'vitest';
import { type ShareStore, stopSharesOnWrite } from './share-stop';

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
