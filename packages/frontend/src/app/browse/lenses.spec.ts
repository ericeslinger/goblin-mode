import type { NoteRecord } from '../notes/notes.service';
import { noteRecord } from '../testing/fakes';
import { byTag, inLens, lensId, projectTree } from './lenses';

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
  ];
  const ids = (lens: Parameters<typeof inLens>[0]) =>
    notes.filter((x) => inLens(lens, x)).map((x) => x.id);

  it('sorts notes into lenses, archived ones only under Archived', () => {
    expect(ids('recent')).toEqual(['text', 'vikas', 'kiln', 'tagged']);
    expect(ids('concepts')).toEqual(['stub', 'vikas', 'kiln']);
    expect(ids('people')).toEqual(['vikas']);
    expect(ids('projects')).toEqual(['kiln']);
    expect(ids('tags')).toEqual(['tagged']);
    expect(ids('archived')).toEqual(['gone']);
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
