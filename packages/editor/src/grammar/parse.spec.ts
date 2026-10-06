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

  it('parses an empty note', () => {
    expect(parseNote('').children).toEqual([]);
  });
});
