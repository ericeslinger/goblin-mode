import { describe, expect, it } from 'vitest';
import { checklist, doneShopping, setDone } from './checklist';

const LIST = [
  'Shopping list',
  '## Meal plan',
  'Tacos Tuesday',
  '## Produce',
  '- [ ] limes',
  '- [x] onions',
  '## Dry goods',
  '- [x] rice ★',
  '- [ ] tortillas',
].join('\n');

describe('checklist', () => {
  it('groups items under their headings, with their lines and staples', () => {
    expect(checklist(LIST)).toEqual([
      {
        heading: 'Produce',
        items: [
          { line: 4, text: 'limes', done: false, staple: false },
          { line: 5, text: 'onions', done: true, staple: false },
        ],
      },
      {
        heading: 'Dry goods',
        items: [
          { line: 7, text: 'rice ★', done: true, staple: true },
          { line: 8, text: 'tortillas', done: false, staple: false },
        ],
      },
    ]);
    expect(checklist('- [ ] loose\n# Later')).toEqual([
      { heading: '', items: [{ line: 0, text: 'loose', done: false, staple: false }] },
    ]);
  });
});

describe('setDone', () => {
  it('changes only the mark on that line', () => {
    expect(setDone(LIST, 4, true)).toBe(LIST.replace('- [ ] limes', '- [x] limes'));
    expect(setDone(LIST, 5, false)).toBe(LIST.replace('- [x] onions', '- [ ] onions'));
    expect(setDone(LIST, 2, true)).toBe(LIST);
  });

  it('finds the item again by its text when the lines moved', () => {
    const moved = LIST.replace('## Produce', '## Produce\n- [ ] leeks');
    // Drawn before leeks arrived: limes was line 4, now line 5.
    expect(setDone(moved, 4, true, 'limes')).toBe(moved.replace('- [ ] limes', '- [x] limes'));
    expect(setDone(moved, 4, true, 'gone')).toBe(moved);
    expect(setDone(LIST, 4, true, 'limes')).toBe(LIST.replace('- [ ] limes', '- [x] limes'));
  });
});

describe('doneShopping', () => {
  it('clears ticked items and brings starred staples back unticked', () => {
    expect(doneShopping(LIST)).toBe(
      [
        'Shopping list',
        '## Meal plan',
        'Tacos Tuesday',
        '## Produce',
        '- [ ] limes',
        '## Dry goods',
        '- [ ] rice ★',
        '- [ ] tortillas',
      ].join('\n'),
    );
  });
});
