import { describe, expect, it } from 'vitest';
import { conceptId, nameIndex, normalizeName, resolveLinks, suggestLinks } from './concepts';
import { autoId } from './ids';

describe('normalizeName', () => {
  it('folds case, Unicode forms and runs of spaces', () => {
    expect(normalizeName('  Project   Hotswap ')).toBe('project hotswap');
    expect(normalizeName('Ｖｉｋａｓ')).toBe('vikas');
    expect(normalizeName('Café')).toBe(normalizeName('Café'));
  });
});

describe('conceptId', () => {
  it('derives the same id from the same name, however it is typed', () => {
    expect(conceptId('Project Hotswap')).toBe('c-project-hotswap');
    expect(conceptId('  project   HOTSWAP')).toBe('c-project-hotswap');
    expect(conceptId('陶芸 pottery')).toBe('c-陶芸-pottery');
  });

  it('adds a hash when the slug does not spell the name, so names stay apart', () => {
    const ids = ['C', 'C++', 'C#', 'a b', 'a-b', 'a/b', 'Cafe', 'Café'].map(conceptId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(conceptId('C')).toBe('c-c');
    expect(conceptId('C++')).toMatch(/^c-c-[0-9a-f]{8}$/);
    expect(conceptId('Café Olé')).toMatch(/^c-cafe-ole-[0-9a-f]{8}$/);
    expect(conceptId('x'.repeat(150))).not.toBe(conceptId('x'.repeat(151)));
  });

  it('falls back to a hash for a name with no letters or digits', () => {
    expect(conceptId('!!!')).toMatch(/^c-[0-9a-f]{8}$/);
    expect(conceptId('!!!')).not.toBe(conceptId('???'));
  });

  it('stays a short, safe document id and never looks like an auto id', () => {
    const id = conceptId('x'.repeat(500));
    expect(id.length).toBeLessThanOrEqual(111);
    expect(id).not.toMatch(/[/]/);
    expect(autoId(() => undefined)).not.toContain('-');
  });
});

describe('nameIndex and resolveLinks', () => {
  const notes = [
    { id: 'n1', title: 'Groceries', kind: 'text' },
    { id: 'c-vikas', title: 'Vikas', kind: 'concept', synonyms: ['Vik'] },
    { id: 'n2', title: 'Vikas', kind: 'text' },
    { id: 'n3', title: 'Old plan', kind: 'text', archived: true },
  ];

  it('resolves concepts by title or synonym before plain notes', () => {
    const index = nameIndex(notes);
    expect(resolveLinks(['vikas', 'VIK', 'groceries'], index)).toEqual(['c-vikas', 'n1']);
  });

  it('points an unknown name, or an archived note’s, at the concept it would make', () => {
    const index = nameIndex(notes);
    expect(resolveLinks(['Pottery', 'Old plan'], index)).toEqual(['c-pottery', 'c-old-plan']);
  });

  it('keeps order and drops repeats', () => {
    expect(resolveLinks(['B', 'a', 'b'], new Map())).toEqual(['c-b', 'c-a']);
  });
});

describe('suggestLinks', () => {
  const notes = [
    { id: 'n1', title: 'Pottery wheel repair', kind: 'text' },
    { id: 'c-pottery', title: 'Pottery', kind: 'concept', conceptType: 'project' },
    { id: 'c-vikas', title: 'Vikas', kind: 'concept', conceptType: 'person', synonyms: ['Vik'] },
    { id: 'n2', title: 'Notes on Pottery glazes', kind: 'text' },
    { id: 'n3', title: 'Pottery kiln (old)', kind: 'text', archived: true },
  ];

  it('ranks prefix matches and concepts first, and offers nothing new for an exact name', () => {
    expect(suggestLinks('pott', notes)).toEqual([
      { name: 'Pottery', kind: 'project' },
      { name: 'Pottery wheel repair', kind: 'note' },
      { name: 'Notes on Pottery glazes', kind: 'note' },
      { name: 'pott', kind: 'new' },
    ]);
    expect(suggestLinks('Pottery', notes).map((s) => s.kind)).not.toContain('new');
  });

  it('matches synonyms, and offers a name nothing has as new', () => {
    expect(suggestLinks('vik', notes)[0]).toEqual({ name: 'Vikas', kind: 'person' });
    expect(suggestLinks('Kiln', notes)).toEqual([{ name: 'Kiln', kind: 'new' }]);
  });

  it('lists everything live for an empty query, up to the limit', () => {
    expect(suggestLinks('', notes, 2)).toHaveLength(2);
  });
});
