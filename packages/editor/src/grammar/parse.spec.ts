import type { ListItem, Nodes } from 'mdast';
import { toString } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';
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

  describe('a lone bullet marker (#118)', () => {
    /** Each top-level block's type; a list gives its items' first child, nested. */
    const shape = (text: string) => {
      const of = (n: Nodes): unknown =>
        n.type === 'list'
          ? n.children.map((li) => li.children.map(of))
          : n.type === 'listItem'
            ? n.children.map(of)
            : n.type;
      return parseNote(text).children.map(of);
    };
    const count = (text: string, type: string) => {
      let n = 0;
      visit(parseNote(text), type, () => void n++);
      return n;
    };

    it('is an empty list item under a list item, not a heading or text', () => {
      for (const marker of ['-', '*', '+']) {
        const text = `- Monday\n  ${marker}`;
        expect(count(text, 'heading')).toBe(0);
        expect(count(text, 'listItem')).toBe(2);
        // Monday's item holds its paragraph and a list of one empty item.
        expect(shape(text)).toEqual([[['paragraph', [[]]]]]);
        expect(toString(parseNote(text))).toBe('Monday');
      }
    });

    it('is an empty item at any indent, with spaces after it or not', () => {
      expect(shape('- sunday\n- Monday\n  -\n- Tuesday')).toEqual([
        [['paragraph'], ['paragraph', [[]]], ['paragraph']],
      ]);
      expect(shape('- Monday\n-')).toEqual([[['paragraph'], []]]);
      expect(shape('- Monday\n  -  ')).toEqual([[['paragraph', [[]]]]]);
    });

    it('starts a list under a line of text, the setext case', () => {
      for (const marker of ['-', '*', '+']) {
        expect(shape(`Monday\n${marker}`)).toEqual(['paragraph', [[]]]);
      }
      expect(count('Monday\n-', 'heading')).toBe(0);
    });

    it('keeps source offsets as typed', () => {
      const text = '- Monday\n  -';
      const items: { start: number; end: number }[] = [];
      visit(parseNote(text), 'listItem', (li: ListItem) => {
        items.push({ start: li.position!.start.offset!, end: li.position!.end.offset! });
      });
      expect(items.map((i) => text.slice(i.start, i.end))).toEqual([text, '-']);
      expect(items[1].start).toBe(11);
    });

    it('leaves other lines alone: `=` underlines, rules, `-text`, `#` headings', () => {
      // Setext headings stay off (2026-10-10), so `===` is text.
      expect(shape('Title\n===')).toEqual(['paragraph']);
      expect(shape('---')).toEqual(['thematicBreak']);
      expect(shape('Monday\n---')).toEqual(['paragraph', 'thematicBreak']);
      expect(shape('Monday\n-b')).toEqual(['paragraph']);
      expect(shape('# Monday')).toEqual(['heading']);
    });
  });

  it('parses an empty note', () => {
    expect(parseNote('').children).toEqual([]);
  });
});
