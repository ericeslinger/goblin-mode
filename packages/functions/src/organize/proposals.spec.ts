import { describe, expect, it } from 'vitest';
import { type GardenNote, type RawProposal, checkProposals, keyOf } from './proposals';

const note = (id: string, title: string, over: Partial<GardenNote> = {}): GardenNote => ({
  id,
  kind: 'text',
  title,
  body: title,
  ...over,
});

const garden: GardenNote[] = [
  note('a', 'Kiln log', { body: 'Kiln log\nCone 6. See [[Glaze recipes]].' }),
  note('b', 'Firing notes'),
  note('g', 'Glaze recipes'),
  note('dup', 'Glaze recipes'),
  note('old', 'Old plan', { archived: true }),
  note('c-vikas', 'Vikas', { kind: 'concept', body: '', synonyms: ['Vik'] }),
  note('c-kiln', 'Kiln', { kind: 'concept', body: '', conceptType: 'project' }),
];

const check = (raw: RawProposal[], known: string[] = [], room = 10) =>
  checkProposals(raw, garden, new Set(known), room);

describe('checkProposals', () => {
  it('keeps a link to notes not yet linked and reachable by name', () => {
    const [p] = check([
      { kind: 'link', from: 'a', to: ['b', 'g', 'dup', 'old', 'zz', 'a'], reason: ' Same kiln. ' },
    ]);
    // g is linked already; dup's name reaches g; old is archived; zz is not a note.
    expect(p).toEqual({
      kind: 'link',
      reason: 'Same kiln.',
      notes: [
        { id: 'a', title: 'Kiln log' },
        { id: 'b', title: 'Firing notes' },
      ],
      key: 'link:a>b',
    });
    expect(check([{ kind: 'link', from: 'a', to: ['g'], reason: 'x' }])).toEqual([]);
    expect(check([{ kind: 'link', from: 'old', to: ['b'], reason: 'x' }])).toEqual([]);
  });

  it('keeps a merge of two or more live text notes, in order', () => {
    const [p] = check([
      { kind: 'merge', ids: ['b', 'a', 'b'], title: ' Kiln ', reason: 'One firing.' },
    ]);
    expect(p).toMatchObject({ notes: [{ id: 'b' }, { id: 'a' }], title: 'Kiln', key: 'merge:a,b' });
    expect(check([{ kind: 'merge', ids: ['a'], reason: 'x' }])).toEqual([]);
    expect(check([{ kind: 'merge', ids: ['a', 'old'], reason: 'x' }])).toEqual([]);
    expect(check([{ kind: 'merge', ids: ['a', 'c-kiln'], reason: 'x' }])).toEqual([]);
  });

  it('keeps a refile that changes something, without names other notes answer to', () => {
    const [p] = check([
      {
        kind: 'refile',
        id: 'c-vikas',
        type: 'person',
        synonyms: ['vik', 'Vikas S.', 'Firing notes', 'vikas s.'],
        reason: 'He is a person.',
      },
    ]);
    expect(p).toEqual({
      kind: 'refile',
      reason: 'He is a person.',
      notes: [{ id: 'c-vikas', title: 'Vikas' }],
      conceptType: 'person',
      synonyms: ['Vikas S.'],
      key: 'refile:c-vikas:person:vikas s.',
    });
    expect(check([{ kind: 'refile', id: 'c-kiln', type: 'project', reason: 'x' }])).toEqual([]);
    expect(check([{ kind: 'refile', id: 'a', type: 'person', reason: 'x' }])).toEqual([]);
  });

  it('drops what was proposed before, repeats, empty reasons, and past the room left', () => {
    const merge: RawProposal = { kind: 'merge', ids: ['a', 'b'], reason: 'x' };
    expect(check([merge], [keyOf(merge)])).toEqual([]);
    expect(check([merge, { ...merge, ids: ['b', 'a'] }])).toHaveLength(1);
    expect(check([{ ...merge, reason: ' ' }])).toEqual([]);
    const two: RawProposal[] = [merge, { kind: 'link', from: 'a', to: ['b'], reason: 'y' }];
    expect(check(two, [], 1)).toHaveLength(1);
  });
});
