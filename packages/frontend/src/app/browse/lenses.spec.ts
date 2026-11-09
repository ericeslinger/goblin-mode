import type { NoteRecord } from '../notes/notes.service';
import { noteRecord } from '../testing/fakes';
import { byTag, goneIn, inLens, lensId, projectTree } from './lenses';

const n = (id: string, over: Partial<NoteRecord> = {}): NoteRecord => ({
  ...noteRecord(id, 'some text'),
  ...over,
});

describe('lenses', () => {
  const notes = [
    n('text'),
    n('empty', { body: '' }),
    n('stub', { body: '', kind: 'concept', conceptType: 'other' }),
    n('vikas', { kind: 'concept', conceptType: 'person' }),
    n('kiln', { kind: 'concept', conceptType: 'project' }),
    n('tagged', { tags: ['feelings', 'home'] }),
    n('gone', { archived: true, kind: 'concept', conceptType: 'person', tags: ['home'] }),
    n('template', { kind: 'template', tags: ['home'] }),
    n('entry', { body: 'Feelings\nMoods: [[calm]]' }),
    n('feelings-template', { kind: 'template', body: 'Feelings\nMoods: ' }),
    n('deleted', { deletedAt: 1, tags: ['home'] }),
    n('deleted-archived', { archived: true, deletedAt: 2 }),
  ];
  const ids = (lens: Parameters<typeof inLens>[0]) =>
    notes.filter((x) => inLens(lens, x)).map((x) => x.id);

  it('sorts notes into lenses, archived ones only under Archived', () => {
    expect(ids('recent')).toEqual(['text', 'vikas', 'kiln', 'tagged', 'entry']);
    expect(ids('journal')).toEqual(['entry']);
    expect(ids('concepts')).toEqual(['stub', 'vikas', 'kiln']);
    expect(ids('people')).toEqual(['vikas']);
    expect(ids('projects')).toEqual(['kiln']);
    expect(ids('tags')).toEqual(['tagged']);
    expect(ids('archived')).toEqual(['gone']);
  });

  it('keeps deleted notes out of every lens but Trash, archived or not (#217)', () => {
    expect(ids('trash')).toEqual(['deleted', 'deleted-archived']);
    for (const lens of ['recent', 'concepts', 'tags', 'journal', 'archived'] as const) {
      expect(ids(lens)).not.toContain('deleted');
      expect(ids(lens)).not.toContain('deleted-archived');
    }
    expect(lensId('trash')).toBe('trash');
  });

  it('says how long a deleted note has left in Trash (#217)', () => {
    const day = 24 * 60 * 60_000;
    const at = Date.parse('2026-11-09T12:00:00Z');
    expect(goneIn(n('x', { deletedAt: at }), at)).toBe('Gone in 30 days');
    expect(goneIn(n('x', { deletedAt: at }), at + 28.5 * day)).toBe('Gone in 2 days');
    expect(goneIn(n('x', { deletedAt: at }), at + 29.5 * day)).toBe('Gone in 1 day');
    expect(goneIn(n('x', { deletedAt: at }), at + 31 * day)).toBe('Gone today');
  });

  it('groups by tag, alphabetically', () => {
    expect(byTag([n('a', { tags: ['home', 'feelings'] }), n('b', { tags: ['home'] })])).toEqual([
      { tag: 'feelings', notes: [expect.objectContaining({ id: 'a' })] },
      {
        tag: 'home',
        notes: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })],
      },
    ]);
  });

  it('falls back to Recent for an unknown lens', () => {
    expect(lensId('people')).toBe('people');
    expect(lensId('bogus')).toBe('recent');
    expect(lensId(undefined)).toBe('recent');
  });

  it('lays projects out as a tree, by name, loops and orphans at the top (#41)', () => {
    const p = (id: string, parent?: string) => n(id, { title: id, parent });
    const tree = projectTree([
      p('sprout'),
      p('leaf', 'sprout'),
      p('bud', 'sprout'),
      p('twig', 'leaf'),
      p('orphan', 'gone'),
      p('loop-a', 'loop-b'),
      p('loop-b', 'loop-a'),
    ]);
    expect(tree.map((t) => `${t.depth}:${t.note.id}`)).toEqual([
      '0:orphan',
      '0:sprout',
      '1:bud',
      '1:leaf',
      '2:twig',
      '0:loop-a',
      '1:loop-b',
    ]);
  });
});
