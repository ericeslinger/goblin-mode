import { describe, expect, it } from 'vitest';
import { parseNote } from '../grammar/parse';
import { computeDecorations, type DecorationSpec, lineStarts, type Mode } from './decorations';

function specs(text: string, mode: Mode, active: number[] = []): DecorationSpec[] {
  return computeDecorations(text, parseNote(text), mode, new Set(active));
}

/** What a hide or widget spec covers, as source text. */
function covered(text: string, list: DecorationSpec[], kind: DecorationSpec['kind']) {
  return list
    .filter((s) => s.kind === kind)
    .map((s) => text.slice(s.from, 'to' in s ? s.to : s.from));
}

describe('lineStarts', () => {
  it('lists the offset of each line', () => {
    expect(lineStarts('ab\n\ncd')).toEqual([0, 3, 4]);
  });
});

describe('computeDecorations in live mode', () => {
  it('hides heading markers and emphasis delimiters off the active line', () => {
    const text = '## Plan\n\nsome **bold** and _it_ and `code`';
    const list = specs(text, 'live');
    expect(covered(text, list, 'hide')).toEqual(['## ', '**', '**', '_', '_', '`', '`']);
    expect(list).toContainEqual({ kind: 'line', from: 0, className: 'gm-h2' });
  });

  it('shows syntax as typed on lines the selection touches', () => {
    const text = '## Plan\n\nsome **bold**';
    expect(covered(text, specs(text, 'live', [3]), 'hide')).toEqual(['## ']);
    expect(covered(text, specs(text, 'live', [1, 3]), 'hide')).toEqual([]);
  });

  it('hides link syntax but not autolinks', () => {
    const text = '[site](https://x.test) and https://y.test';
    expect(covered(text, specs(text, 'live'), 'hide')).toEqual(['[', '](https://x.test)']);
  });

  it('draws wiki links, images and task checkboxes as widgets', () => {
    const text = '- [ ] call [[Vikas|vik]]\n- [x] done\n\n![page](attachment:abc)';
    const list = specs(text, 'live');
    expect(list).toContainEqual({
      kind: 'wikiLink',
      from: 11,
      to: 24,
      target: 'Vikas',
      alias: 'vik',
    });
    expect(covered(text, list, 'checkbox')).toEqual(['- [ ]', '- [x]']);
    const open = list.find((s) => s.kind === 'checkbox' && !s.checked);
    expect(open && 'toggleAt' in open && text[open.toggleAt]).toBe(' ');
    expect(covered(text, list, 'image')).toEqual(['![page](attachment:abc)']);
    expect(list).toContainEqual({ kind: 'line', from: 25, className: 'gm-done' });
  });

  it('keeps a task line as typed while the cursor is on it', () => {
    const text = '- [ ] call [[Vikas]]';
    expect(covered(text, specs(text, 'live', [1]), 'checkbox')).toEqual([]);
    expect(covered(text, specs(text, 'live', [1]), 'wikiLink')).toEqual([]);
  });
});

describe('list markers', () => {
  it('draws bullets for -, * and + items off the edited line', () => {
    const text = '- one\n* two\n+ three';
    expect(covered(text, specs(text, 'live'), 'bullet')).toEqual(['-', '*', '+']);
  });

  it('shows the marker as typed on the edited line', () => {
    const text = '- one\n- two';
    expect(covered(text, specs(text, 'live', [2]), 'bullet')).toEqual(['-']);
  });

  it('keeps ordered numbers as text, styled', () => {
    const text = '1. eight\n2. nine';
    const list = specs(text, 'live');
    expect(covered(text, list, 'bullet')).toEqual([]);
    expect(list).toContainEqual({ kind: 'mark', from: 0, to: 2, className: 'gm-list-number' });
  });
});

describe('computeDecorations in source mode', () => {
  it('styles but never hides or replaces anything', () => {
    const text = '# T\n\n- [ ] **x** [[Vikas]] ![a](attachment:b)';
    const list = specs(text, 'source');
    expect(list.some((s) => s.kind !== 'line' && s.kind !== 'mark')).toBe(false);
    expect(list).toContainEqual({ kind: 'line', from: 0, className: 'gm-h1' });
  });
});
