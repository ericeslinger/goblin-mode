import { describe, expect, it } from 'vitest';
import { conceptId, nameIndex, normalizeName, resolveLinks } from './concepts';
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
    expect(conceptId('Café Olé')).toBe('c-cafe-ole');
  });

  it('keeps letters in any script and drops the rest', () => {
    expect(conceptId('陶芸 (pottery)')).toBe('c-陶芸-pottery');
    expect(conceptId('a/b.c')).toBe('c-a-b-c');
  });

  it('falls back to a hash for a name with no letters or digits', () => {
    expect(conceptId('!!!')).toMatch(/^c-[0-9a-f]{8}$/);
    expect(conceptId('!!!')).not.toBe(conceptId('???'));
  });

  it('stays a short, safe document id and never looks like an auto id', () => {
    const id = conceptId('x'.repeat(500));
    expect(id.length).toBeLessThanOrEqual(102);
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
