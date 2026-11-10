import { describe, expect, it } from 'vitest';
import { lineDiff, textLines } from './diff';

const marks = (before: string, after: string, max?: number) =>
  lineDiff(before, after, max).lines.map((l) => `${l.kind[0]} ${l.text}`);

describe('lineDiff', () => {
  it('marks added lines and keeps the rest', () => {
    expect(marks('Kiln log\n- bisque', 'Kiln log\n- bisque\n- glaze\n- fire')).toEqual([
      'k Kiln log',
      'k - bisque',
      'a - glaze',
      'a - fire',
    ]);
  });

  it('marks removed lines', () => {
    expect(marks('one\ntwo\nthree', 'one\nthree')).toEqual(['k one', 'r two', 'k three']);
  });

  it('reads a changed line as removed then added', () => {
    expect(marks('a\nold line\nc', 'a\nnew line\nc')).toEqual([
      'k a',
      'r old line',
      'a new line',
      'k c',
    ]);
  });

  it('keeps a stretch both share in the middle of changes', () => {
    expect(marks('x\nkeep\ny', 'p\nkeep\nq')).toEqual(['r x', 'a p', 'k keep', 'r y', 'a q']);
  });

  it('keeps every line of identical texts', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual({
      lines: [
        { kind: 'kept', text: 'a' },
        { kind: 'kept', text: 'b' },
      ],
      capped: false,
    });
  });

  it('adds every line after an empty before', () => {
    expect(marks('', 'new\nnote')).toEqual(['a new', 'a note']);
  });

  it('removes every line before an empty after', () => {
    expect(marks('gone\nnow', '')).toEqual(['r gone', 'r now']);
    expect(lineDiff('', '').lines).toEqual([]);
  });

  it('gives a middle too long to compare whole, removed then added', () => {
    const diff = lineDiff('top\na\nb\nend', 'top\nb\nc\nend', 3);
    expect(diff.capped).toBe(true);
    expect(diff.lines.map((l) => `${l.kind[0]} ${l.text}`)).toEqual([
      'k top',
      'r a',
      'r b',
      'a b',
      'a c',
      'k end',
    ]);
    expect(lineDiff('top\na\nb\nend', 'top\nb\nc\nend', 4).capped).toBe(false);
  });

  it('keeps blank lines as lines', () => {
    expect(textLines('a\n\nb')).toEqual(['a', '', 'b']);
    expect(marks('a\n', 'a\n\n')).toEqual(['k a', 'k ', 'a ']);
  });
});
