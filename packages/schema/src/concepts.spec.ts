import { describe, expect, it } from 'vitest';
import {
  backlinks,
  conceptId,
  nameIndex,
  neighborhood,
  normalizeName,
  oftenTogether,
  resolveLinks,
  sentenceAround,
  suggestLinks,
} from './concepts';
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
    { id: 'n4', title: 'Kiln log', kind: 'text', synonyms: ['Firing notes', 'Groceries'] },
  ];

  it('resolves concepts by title or synonym before plain notes', () => {
    const index = nameIndex(notes);
    expect(resolveLinks(['vikas', 'VIK', 'groceries'], index)).toEqual(['c-vikas', 'n1']);
  });

  it('resolves a merged note by its originals’ titles, after every title', () => {
    const index = nameIndex(notes);
    expect(resolveLinks(['firing notes', 'groceries'], index)).toEqual(['n4', 'n1']);
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

describe('backlinks and oftenTogether', () => {
  const notes = [
    { id: 'n1', links: ['c-kiln', 'c-glaze', 'c-vikas'] },
    { id: 'n2', links: ['c-kiln', 'c-glaze'] },
    { id: 'n3', links: ['c-kiln', 'n9'], archived: true },
    { id: 'n4', links: ['c-glaze'] },
    { id: 'c-kiln', links: ['c-kiln'] },
  ];

  it('lists live notes linking to an id, never the note itself', () => {
    expect(backlinks('c-kiln', notes).map((n) => n.id)).toEqual(['n1', 'n2']);
  });

  it('ranks concepts by how many notes they share', () => {
    expect(oftenTogether('c-kiln', notes)).toEqual([
      { id: 'c-glaze', shared: 2 },
      { id: 'c-vikas', shared: 1 },
    ]);
    expect(oftenTogether('c-kiln', notes, 1)).toEqual([{ id: 'c-glaze', shared: 2 }]);
  });
});

describe('sentenceAround', () => {
  it('takes the sentence holding the span, on its line, without list marks', () => {
    const body = 'Title\n- Fire it Friday. Ask [[Vikas]] about the kiln. Then glaze.\nmore';
    const start = body.indexOf('[[');
    expect(sentenceAround(body, start, start + 9)).toBe('Ask [[Vikas]] about the kiln.');
  });

  it('keeps a whole short line, and shortens a long one', () => {
    expect(sentenceAround('see [[A]]', 4, 9)).toBe('see [[A]]');
    expect(sentenceAround(`[[A]] ${'x'.repeat(300)}`, 0, 5, 20)).toHaveLength(20);
  });
});

describe('neighborhood', () => {
  const notes = [
    { id: 'a', links: ['c-kiln'] },
    { id: 'b', links: ['c-kiln', 'c-glaze'] },
    { id: 'c', links: ['c-glaze'] },
    { id: 'gone', links: ['c-kiln'], archived: true },
    { id: 'c-kiln', links: [] },
    { id: 'c-glaze', links: [] },
    { id: 'far', links: ['c'] },
  ];

  it('rings the center with what it links and what links it, two hops out', () => {
    const { nodes, edges } = neighborhood('c-kiln', notes);
    expect(nodes).toEqual([
      { id: 'c-kiln', hop: 0 },
      { id: 'b', hop: 1 },
      { id: 'a', hop: 1 },
      { id: 'c-glaze', hop: 2, via: 'b' },
    ]);
    expect(edges).toEqual([
      ['a', 'c-kiln'],
      ['b', 'c-kiln'],
      ['b', 'c-glaze'],
    ]);
  });

  it('caps each ring, and is empty for an unknown or archived center', () => {
    expect(neighborhood('c-kiln', notes, { hop1: 1, hop2: 0 }).nodes.map((n) => n.id)).toEqual([
      'c-kiln',
      'b',
    ]);
    expect(neighborhood('gone', notes).nodes).toEqual([]);
    expect(neighborhood('nope', notes).nodes).toEqual([]);
  });
});
