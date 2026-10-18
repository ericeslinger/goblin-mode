import { describe, expect, it } from 'vitest';
import { addBought, editPantry, onHand, pantryItems, recipeKeys, useUp } from './pantry';

const PANTRY = [
  '## Produce',
  '',
  '- onions: 3',
  '- 2 lemons',
  '',
  '## Dry goods',
  '',
  '- olive oil: always',
  '- [ ] not an item, a task',
  '',
].join('\n');

describe('on hand (#131)', () => {
  it('reads items, their amounts, always, and sections', () => {
    expect(pantryItems(PANTRY)).toEqual([
      { line: 2, item: 'onions', key: 'onions', amount: '3', always: false, section: 'Produce' },
      { line: 3, item: '2 lemons', key: 'lemons', always: false, section: 'Produce' },
      { line: 7, item: 'olive oil', key: 'olive oil', always: true, section: 'Dry goods' },
    ]);
    expect(onHand(PANTRY)).toEqual(new Set(['onions', 'lemons', 'olive oil']));
  });

  it('adds what was bought, under its section, once, without amounts or dinners', () => {
    const { body, added } = addBought(PANTRY, [
      { text: '400 g tomatoes (Shakshuka, Mon)', section: 'Produce' },
      { text: '1 cup lentils ×0.5 (Dal, Tue)', section: 'From recipes' },
      { text: 'onions', section: 'Produce' },
      { text: 'rice ★', section: 'Dry goods' },
      { text: 'chicken thighs', section: 'Butcher' },
    ]);
    expect(added).toEqual(['tomatoes', 'lentils', 'rice', 'chicken thighs']);
    expect(body).toBe(
      [
        '## Produce',
        '',
        '- onions: 3',
        '- 2 lemons',
        '- tomatoes',
        '',
        '## Dry goods',
        '',
        '- olive oil: always',
        '- [ ] not an item, a task',
        '- rice',
        '',
        '## Other',
        '',
        '- lentils',
        '',
        '## Butcher',
        '',
        '- chicken thighs',
        '',
      ].join('\n'),
    );
  });

  it('takes off what a made dinner used, except what is always there', () => {
    const recipe = '## Ingredients\n\n- 2 onions, sliced\n- 1 tbsp olive oil\n- salt\n';
    const { body, used } = useUp(PANTRY, recipeKeys(recipe));
    expect(used).toEqual(['onions']);
    expect(body).not.toContain('onions');
    expect(body).toContain('- olive oil: always');
    expect(useUp(PANTRY, new Set(['nothing'])).body).toBe(PANTRY);
  });

  it('edits only the lines Claude names', () => {
    const body = editPantry(PANTRY, {
      add: [
        { item: 'rice', section: 'Dry goods' },
        { item: 'Onions' },
        { item: 'salt', always: true },
      ],
      remove: ['lemons'],
      always: ['onions'],
    });
    expect(body).toContain('- onions: always');
    expect(body).not.toContain('lemons');
    expect(body).toContain('- [ ] not an item, a task\n- rice');
    expect(body.match(/onions/g)).toHaveLength(1);
    expect(body.trimEnd().endsWith('## Other\n\n- salt: always')).toBe(true);
  });
});
