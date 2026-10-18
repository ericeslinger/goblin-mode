import { describe, expect, it } from 'vitest';
import {
  FROM_RECIPES,
  addDinner,
  dinnerLines,
  itemKey,
  listSections,
  removeDinner,
  replanGrocery,
} from './grocery';

const RECIPE = [
  '## Ingredients',
  '',
  '- 2 onions, sliced',
  '- 400 g tomatoes',
  '- 2-3 cloves garlic',
  '- salt',
  '',
  '## Method',
  '',
  '1. Cook.',
].join('\n');

const LIST = [
  'Shopping list',
  '',
  '## Produce',
  '',
  '- [x] tomatoes',
  '- [ ] limes',
  '',
  '## Dry goods',
  '',
  '- [ ] salt',
  '',
].join('\n');

describe('the grocery list (#130)', () => {
  it('writes a dinner’s lines, scaled by its ratio, naming the dinner', () => {
    expect(dinnerLines(RECIPE, 'Shakshuka', 'Mon').map((l) => l.line)).toEqual([
      '- [ ] 2 onions, sliced (Shakshuka, Mon)',
      '- [ ] 400 g tomatoes (Shakshuka, Mon)',
      '- [ ] 2-3 cloves garlic (Shakshuka, Mon)',
      '- [ ] salt (Shakshuka, Mon)',
    ]);
    expect(dinnerLines(RECIPE, 'Shakshuka', 'Mon', 0.5).map((l) => l.line)).toEqual([
      '- [ ] 1 onions, sliced (Shakshuka, Mon)',
      '- [ ] 200 g tomatoes (Shakshuka, Mon)',
      '- [ ] 2-3 cloves garlic ×0.5 (Shakshuka, Mon)',
      '- [ ] salt ×0.5 (Shakshuka, Mon)',
    ]);
  });

  it('files lines where their items went, skipping what is listed unticked', () => {
    const add = dinnerLines(RECIPE, 'Shakshuka', 'Mon');
    const { body, added } = addDinner(LIST, add, { garlic: 'Produce' });
    expect(added).toBe(3);
    expect(body).toBe(
      [
        'Shopping list',
        '',
        '## Produce',
        '',
        '- [x] tomatoes',
        '- [ ] limes',
        '- [ ] 400 g tomatoes (Shakshuka, Mon)',
        '- [ ] 2-3 cloves garlic (Shakshuka, Mon)',
        '',
        '## Dry goods',
        '',
        '- [ ] salt',
        '',
        `## ${FROM_RECIPES}`,
        '',
        '- [ ] 2 onions, sliced (Shakshuka, Mon)',
        '',
      ].join('\n'),
    );
    // A second dinner needing onions: they are on the list, unticked.
    const again = addDinner(body, dinnerLines(RECIPE, 'Dal', 'Tue'));
    expect(again.body).toBe(body);
    expect(again.added).toBe(0);
    // Something on hand (#131) is skipped too.
    expect(addDinner(LIST, add, {}, new Set(['onions', 'tomatoes', 'garlic'])).added).toBe(0);
  });

  it('learns sections from the list, and reads items under their amounts and dinners', () => {
    expect(itemKey('2 onions, sliced (Shakshuka, Mon)')).toBe('onions');
    expect(itemKey('salt ×0.5 (Dal, Tue)')).toBe('salt');
    expect(listSections(LIST)).toEqual({
      tomatoes: 'Produce',
      limes: 'Produce',
      salt: 'Dry goods',
    });
  });

  it('takes a dinner off: its unticked lines as written go, ticked or edited ones stay', () => {
    const add = dinnerLines(RECIPE, 'Shakshuka', 'Mon');
    const { body } = addDinner(LIST, add);
    const edited = body
      .replace('- [ ] 2 onions, sliced (Shakshuka, Mon)', '- [ ] 3 onions (Shakshuka, Mon)')
      .replace('- [ ] 400 g tomatoes (Shakshuka, Mon)', '- [x] 400 g tomatoes (Shakshuka, Mon)');
    const { body: after, removed } = removeDinner(edited, add);
    expect(removed).toBe(1);
    expect(after).toContain('- [ ] 3 onions (Shakshuka, Mon)');
    expect(after).toContain('- [x] 400 g tomatoes (Shakshuka, Mon)');
    expect(after).not.toContain('garlic (Shakshuka, Mon)');
  });
});

describe('replanGrocery (#130)', () => {
  it('swaps one dinner’s lines for another’s, and leaves a same dinner alone', () => {
    const dal = '## Ingredients\n\n- 1 cup lentils\n';
    const mon = { recipe: 'Shakshuka', recipeBody: RECIPE, day: 'Mon' };
    const first = replanGrocery(LIST, undefined, mon);
    expect(first.added).toBe(3);
    expect(replanGrocery(first.body, mon, { ...mon, recipe: 'shakshuka' }).body).toBe(first.body);
    const swapped = replanGrocery(first.body, mon, { recipe: 'Dal', recipeBody: dal, day: 'Mon' });
    expect(swapped).toMatchObject({ added: 1, removed: 3 });
    expect(swapped.body).toContain('- [ ] 1 cup lentils (Dal, Mon)');
    expect(swapped.body).not.toContain('(Shakshuka, Mon)');
    expect(
      replanGrocery(swapped.body, { recipe: 'Dal', recipeBody: dal, day: 'Mon' }, undefined),
    ).toMatchObject({ removed: 1 });
  });
});
