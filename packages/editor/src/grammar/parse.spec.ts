import { describe, expect, it } from 'vitest';
import { parseNote } from './parse';

describe('parseNote', () => {
  it('records source offsets on every node', () => {
    const text = 'Hello **world**';
    const root = parseNote(text);
    const strong = (
      root.children[0] as {
        children: {
          type: string;
          position: { start: { offset: number }; end: { offset: number } };
        }[];
      }
    ).children[1];
    expect(strong.type).toBe('strong');
    expect(text.slice(strong.position.start.offset, strong.position.end.offset)).toBe('**world**');
  });

  it('reads a lone `-` under a line as a list item in progress, not a heading (#118)', () => {
    const types = (text: string) =>
      parseNote(text).children.flatMap((n) =>
        n.type === 'list' ? n.children.map((li) => li.children[0]?.type ?? 'empty') : [n.type],
      );
    // The bare `-` cannot start a list inside the paragraph (CommonMark),
    // so it stays in Monday's paragraph as text, drawn as typed.
    const root = parseNote('- sunday\n- Monday\n  -\n- Tuesday');
    expect(root.children[0].type).toBe('list');
    expect(types('- sunday\n- Monday\n  -\n- Tuesday')).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    const monday = (
      root.children[0] as { children: { children: { children: { value?: string }[] }[] }[] }
    ).children[1].children[0];
    expect(monday.children.map((c) => c.value).join('')).toBe('Monday\n-');
    expect(types('Monday\n---')).toEqual(['paragraph', 'thematicBreak']);
    expect(types('# Monday')).toEqual(['heading']);
  });

  it('parses an empty note', () => {
    expect(parseNote('').children).toEqual([]);
  });
});
