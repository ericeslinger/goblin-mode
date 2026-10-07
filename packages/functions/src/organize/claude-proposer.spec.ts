import { describe, expect, it, vi } from 'vitest';
import { ORGANIZE_MODEL, claudeProposer, digest, parseAnswer } from './claude-proposer';
import type { GardenNote } from './proposals';

const garden: GardenNote[] = [
  { id: 'a', kind: 'text', title: 'Kiln log', body: 'Kiln log\nCone 6.' },
  { id: 'b', kind: 'text', title: 'Firing notes', body: 'Firing notes' },
  { id: 'gone', kind: 'text', title: 'Old', body: 'Old', archived: true },
  { id: 'c-vikas', kind: 'concept', title: 'Vikas', body: '', synonyms: ['Vik'] },
];

describe('digest', () => {
  it('shows recent notes whole, the others by name, and concepts with their names', () => {
    const text = digest(garden, [garden[0]]);
    expect(text).toContain('c-vikas | Vikas | other | Vik');
    expect(text).toContain('<note id="a" kind="text">\nKiln log\nCone 6.\n</note>');
    expect(text).toContain('b | Firing notes');
    expect(text).not.toContain('a | Kiln log');
    expect(text).not.toContain('Old');
  });
});

describe('parseAnswer', () => {
  it('keeps each suggestion with the right shape', () => {
    expect(
      parseAnswer({
        proposals: [
          { kind: 'merge', ids: ['a', 'b'], reason: 'Same firing.' },
          { kind: 'link', from: 'a', reason: 'no targets' },
          { kind: 'delete', id: 'a', reason: 'no' },
        ],
      }),
    ).toEqual([{ kind: 'merge', ids: ['a', 'b'], reason: 'Same firing.' }]);
    expect(parseAnswer(undefined)).toEqual([]);
  });
});

describe('claudeProposer', () => {
  it('asks Claude through the propose tool and reads its answer', async () => {
    const create = vi.fn(async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'propose',
          input: { proposals: [{ kind: 'link', from: 'a', to: ['b'], reason: 'Kiln.' }] },
        },
      ],
    }));
    const propose = claudeProposer({ messages: { create } } as never);
    expect(await propose(garden, [garden[0]])).toEqual([
      { kind: 'link', from: 'a', to: ['b'], reason: 'Kiln.' },
    ]);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: ORGANIZE_MODEL,
        tool_choice: { type: 'tool', name: 'propose' },
      }),
    );
  });
});
