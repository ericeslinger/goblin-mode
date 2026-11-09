import { describe, expect, it } from 'vitest';
import {
  FROM_RECIPES,
  addDinner,
  dinnerLines,
  feedsList,
  itemKey,
  listIsOlder,
  listSections,
  listSources,
  pruneWrote,
  removeDinner,
  replanGrocery,
  shoppingListBody,
  shoppingListId,
  shoppingListTitle,
  slotKey,
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
  it('writes a dinner’s lines, scaled by its ratio, only the item (#207)', () => {
    expect(dinnerLines(RECIPE).map((l) => l.line)).toEqual([
      '- [ ] 2 onions, sliced',
      '- [ ] 400 g tomatoes',
      '- [ ] 2-3 cloves garlic',
      '- [ ] salt',
    ]);
    expect(dinnerLines(RECIPE, 0.5).map((l) => l.line)).toEqual([
      '- [ ] 1 onions, sliced',
      '- [ ] 200 g tomatoes',
      '- [ ] 2-3 cloves garlic ×0.5',
      '- [ ] salt ×0.5',
    ]);
  });

  it('files lines where their items went, skipping what is listed unticked', () => {
    const add = dinnerLines(RECIPE);
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
        '- [ ] 400 g tomatoes',
        '- [ ] 2-3 cloves garlic',
        '',
        '## Dry goods',
        '',
        '- [ ] salt',
        '',
        `## ${FROM_RECIPES}`,
        '',
        '- [ ] 2 onions, sliced',
        '',
      ].join('\n'),
    );
    // A second dinner needing onions: they are on the list, unticked.
    const again = addDinner(body, dinnerLines(RECIPE));
    expect(again.body).toBe(body);
    expect(again.added).toBe(0);
    // Something on hand (#131) is skipped too.
    expect(addDinner(LIST, add, {}, new Set(['onions', 'tomatoes', 'garlic'])).added).toBe(0);
  });

  it('learns sections from the list, and reads items under their amounts and dinners', () => {
    expect(itemKey('2 onions, sliced')).toBe('onions');
    // A list from before #207 still names the dinner.
    expect(itemKey('2 onions, sliced (Shakshuka, Mon)')).toBe('onions');
    expect(itemKey('salt ×0.5 (Dal, Tue)')).toBe('salt');
    expect(listSections(LIST)).toEqual({
      tomatoes: 'Produce',
      limes: 'Produce',
      salt: 'Dry goods',
    });
  });

  it('takes a dinner off: the lines it wrote, unticked as written; ticked, edited or Eric’s stay', () => {
    const { body, lines } = addDinner(LIST, dinnerLines(RECIPE));
    // What went on: not the salt, which Eric had listed already.
    expect(lines).toEqual([
      '- [ ] 2 onions, sliced',
      '- [ ] 2-3 cloves garlic',
      '- [ ] 400 g tomatoes',
    ]);
    const wrote = lines.map((line) => ({ line, key: itemKey(line.slice(6)) }));
    const edited = body
      .replace('- [ ] 2 onions, sliced', '- [ ] 3 onions')
      .replace('- [ ] 400 g tomatoes', '- [x] 400 g tomatoes');
    const { body: after, removed } = removeDinner(edited, wrote);
    expect(removed).toBe(1);
    expect(after).toContain('- [ ] 3 onions');
    expect(after).toContain('- [x] 400 g tomatoes');
    expect(after).not.toContain('garlic');
    // Eric's own salt reads as the recipe's would, and stays (#207).
    expect(after).toContain('- [ ] salt');
  });
});

describe('replanGrocery (#130)', () => {
  const SLOT = '2026-10-19/Mon/dinner';
  const mon = { recipe: 'Shakshuka', recipeBody: RECIPE, day: 'Mon', slot: SLOT };

  it('swaps one dinner’s lines for another’s, and leaves a same dinner alone', () => {
    const dal = '## Ingredients\n\n- 1 cup lentils\n';
    const first = replanGrocery(LIST, undefined, mon);
    expect(first.added).toBe(3);
    expect(first.wrote).toEqual({
      [SLOT]: ['- [ ] 2 onions, sliced', '- [ ] 2-3 cloves garlic', '- [ ] 400 g tomatoes'],
    });
    const same = replanGrocery(
      first.body,
      mon,
      { ...mon, recipe: 'shakshuka' },
      {},
      new Set(),
      [],
      first.wrote,
    );
    expect(same.body).toBe(first.body);
    expect(same.wrote).toEqual(first.wrote);
    const dalMon = { recipe: 'Dal', recipeBody: dal, day: 'Mon', slot: SLOT };
    const swapped = replanGrocery(first.body, mon, dalMon, {}, new Set(), [], first.wrote);
    // Shakshuka's three lines; Eric's salt stays (#207).
    expect(swapped).toMatchObject({
      added: 1,
      removed: 3,
      wrote: { [SLOT]: ['- [ ] 1 cup lentils'] },
    });
    expect(swapped.body).toContain('- [ ] 1 cup lentils');
    expect(swapped.body).toContain('- [ ] salt');
    expect(swapped.body).not.toContain('onions');
    const cleared = replanGrocery(
      swapped.body,
      dalMon,
      undefined,
      {},
      new Set(),
      [],
      swapped.wrote,
    );
    expect(cleared).toMatchObject({ removed: 1, wrote: {} });
  });

  it('takes off an identical line only when the dinner wrote it (#207)', () => {
    const limes = {
      recipe: 'Soup',
      recipeBody: '## Ingredients\n\n- limes\n',
      day: 'Mon',
      slot: SLOT,
    };
    const own = '## Produce\n\n- [ ] limes\n';
    // Eric's limes were there first: the dinner wrote nothing, takes nothing.
    const skipped = replanGrocery(own, undefined, limes);
    expect(skipped).toMatchObject({ added: 0, wrote: {} });
    expect(replanGrocery(own, limes, undefined, {}, new Set(), [], skipped.wrote).body).toBe(own);
    // The dinner's own limes, the very same words, go when it does.
    const put = replanGrocery('## Produce\n', undefined, limes);
    expect(put.body).toContain('- [ ] limes');
    const gone = replanGrocery(put.body, limes, undefined, {}, new Set(), [], put.wrote);
    expect(gone).toMatchObject({ removed: 1, wrote: {} });
    expect(gone.body).not.toContain('limes');
    // A slot with nothing recorded (planned before the record) takes nothing.
    expect(replanGrocery(put.body, limes, undefined).body).toBe(put.body);
  });

  it('puts back an item another dinner still needs when one comes off (review on #139)', () => {
    const TUE = '2026-10-19/Tue/dinner';
    const tue = { ...mon, day: 'Tue', slot: TUE };
    const once = replanGrocery(LIST, undefined, mon);
    // Tuesday's onions were already listed, for Monday: Tuesday wrote nothing.
    const both = replanGrocery(once.body, undefined, tue, {}, new Set(), [], once.wrote);
    expect(both.body).toBe(once.body);
    expect(both.wrote[TUE]).toBeUndefined();
    const cleared = replanGrocery(both.body, mon, undefined, {}, new Set(), [tue], both.wrote);
    expect(cleared.body.match(/2 onions, sliced/g)).toHaveLength(1);
    expect(cleared.body).toContain('- [ ] 400 g tomatoes');
    // Now Tuesday's own lines, recorded under its slot.
    expect(cleared.wrote).toEqual({
      [TUE]: expect.arrayContaining(['- [ ] 2 onions, sliced', '- [ ] 400 g tomatoes']),
    });
    // Something Eric took off himself is not brought back.
    const deleted = both.body.replace('- [ ] 400 g tomatoes\n', '');
    expect(
      replanGrocery(deleted, mon, undefined, {}, new Set(), [tue], both.wrote).body,
    ).not.toContain('400 g tomatoes');
  });

  it('keeps the record to the list’s week and newer', () => {
    const wrote = {
      '2026-10-12/Mon/dinner': ['- [ ] rice'],
      '2026-10-19/Mon/dinner': ['- [ ] limes'],
      '2026-10-19/Tue/dinner': [],
    };
    expect(pruneWrote(wrote, '2026-10-19')).toEqual({ '2026-10-19/Mon/dinner': ['- [ ] limes'] });
    expect(Object.keys(pruneWrote(wrote, undefined))).toHaveLength(2);
    expect(slotKey('2026-10-19', 'Mon', 'dinner')).toBe('2026-10-19/Mon/dinner');
  });
});

describe('a list a week (#207)', () => {
  it('names and ids a week’s list, and says when a plan wants a new one', () => {
    expect(shoppingListId('2026-10-19')).toBe('shopping-2026-10-19');
    expect(shoppingListTitle('2026-10-19')).toBe('Shopping list, week of Oct 19');
    expect(listIsOlder('2026-10-12', '2026-10-19')).toBe(true);
    expect(listIsOlder('2026-10-19', '2026-10-19')).toBe(false);
    expect(listIsOlder('2026-10-26', '2026-10-19')).toBe(false);
    // A list from before #207 has no week: taken as the week's, not older.
    expect(listIsOlder(undefined, '2026-10-19')).toBe(false);
    // A dinner in a week older than the list's feeds no list (2026-11-09).
    expect(feedsList('2026-10-26', '2026-10-19')).toBe(false);
    expect(feedsList('2026-10-26', '2026-10-26')).toBe(true);
    expect(feedsList('2026-10-26', '2026-11-02')).toBe(true);
    expect(feedsList(undefined, '2026-10-19')).toBe(true);
  });

  it('starts a list from the template, without its instructions or Meal plan, keeping staples', () => {
    const template = [
      'Shopping list',
      '',
      '## Meal plan',
      '',
      '- Mon: soup',
      '',
      '## Produce',
      '',
      '## Dry goods',
      '',
      '## Instructions for Claude',
      '',
      'Add things.',
      '',
    ].join('\n');
    expect(shoppingListBody(template)).toBe('Shopping list\n\n## Produce\n\n## Dry goods');
    const before = [
      'Shopping list',
      '',
      '## Produce',
      '',
      '- [ ] limes',
      '- [x] garlic ★',
      '',
      '## Dry goods',
      '',
      '- [ ] rice ★',
      '',
    ].join('\n');
    expect(shoppingListBody(template, 'Add things.', before)).toBe(
      [
        'Shopping list',
        '',
        '## Produce',
        '',
        '- [ ] garlic ★',
        '',
        '## Dry goods',
        '',
        '- [ ] rice ★',
      ].join('\n'),
    );
  });

  it('says which of the week’s dinners need each open item, never what is ticked', () => {
    const chili = '## Ingredients\n\n- 2 onions\n- beans\n';
    const list = [
      '## Produce',
      '',
      '- [ ] 2 onions, sliced',
      '- [x] 400 g tomatoes',
      '- [ ] limes',
      '',
      '## Dry goods',
      '',
      '- [ ] beans (Chili, Thu)',
    ].join('\n');
    const dinners = [
      { recipe: 'Shakshuka', recipeBody: RECIPE, day: 'Mon' },
      { recipe: 'Chili', recipeBody: chili, day: 'Thu' },
      { recipe: 'Chili', recipeBody: chili, day: 'Thu' },
    ];
    expect(listSources(list, dinners)).toEqual([
      { item: '2 onions, sliced', dinners: ['Shakshuka (Mon)', 'Chili (Thu)'] },
      { item: 'beans (Chili, Thu)', dinners: ['Chili (Thu)'] },
    ]);
  });
});
