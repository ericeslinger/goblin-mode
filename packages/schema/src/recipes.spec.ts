import { describe, expect, it } from 'vitest';
import {
  importPlaceholder,
  ingredients,
  isImportPlaceholder,
  methodSteps,
  parseIngredient,
  recipeBody,
  recipeSkeleton,
  untouchedRecipe,
} from './recipes';

describe('parseIngredient (#127)', () => {
  it('reads amount, unit, item and note', () => {
    expect(parseIngredient('2 cups flour, sifted')).toEqual({
      line: 0,
      text: '2 cups flour, sifted',
      quantity: '2',
      amount: 2,
      unit: 'cup',
      item: 'flour',
      note: 'sifted',
    });
    expect(parseIngredient('1 1/2 tbsp olive oil')).toMatchObject({
      quantity: '1 1/2',
      amount: 1.5,
      unit: 'tbsp',
      item: 'olive oil',
    });
    expect(parseIngredient('½ tsp salt')).toMatchObject({ amount: 0.5, unit: 'tsp', item: 'salt' });
    expect(parseIngredient('2-3 cloves garlic')).toMatchObject({
      quantity: '2-3',
      amount: 2,
      unit: 'clove',
      item: 'garlic',
    });
    expect(parseIngredient('400 g tinned tomatoes')).toMatchObject({
      amount: 400,
      unit: 'g',
      item: 'tinned tomatoes',
    });
  });

  it('takes a line with no amount as just the item', () => {
    expect(parseIngredient('a handful of parsley')).toMatchObject({
      unit: 'handful',
      item: 'parsley',
    });
    expect(parseIngredient('a handful of parsley').quantity).toBeUndefined();
    expect(parseIngredient('salt and pepper, to taste')).toEqual({
      line: 0,
      text: 'salt and pepper, to taste',
      item: 'salt and pepper',
      note: 'to taste',
    });
    expect(parseIngredient('3 eggs')).toMatchObject({ amount: 3, item: 'eggs' });
    expect(parseIngredient('3 eggs').unit).toBeUndefined();
    // A one-letter word is a unit only after an amount.
    expect(parseIngredient('t-bone steak').item).toBe('t-bone steak');
    // Any case, but T and t stay tablespoon and teaspoon (review on #135).
    expect(parseIngredient('1 Tbsp olive oil')).toMatchObject({ unit: 'tbsp', item: 'olive oil' });
    expect(parseIngredient('2 CUPS flour')).toMatchObject({ unit: 'cup', item: 'flour' });
    expect(parseIngredient('1 T butter').unit).toBe('tbsp');
    expect(parseIngredient('1 t salt').unit).toBe('tsp');
    expect(parseIngredient('2 constructor beams').unit).toBeUndefined();
  });
});

describe('ingredients and methodSteps (#127)', () => {
  const body = [
    '## Ingredients',
    '',
    '- 2 onions, sliced',
    '### For the sauce',
    '- 400 g tomatoes',
    '* 1 tsp cumin',
    'a loose line',
    '',
    '## Method',
    '',
    '1. Soften the onions.',
    '2. Add the sauce.',
    '- Crack in the eggs.',
    '',
    '## Notes',
    '- not an ingredient',
  ].join('\n');

  it('reads the Ingredients section, line by line, with groups', () => {
    expect(ingredients(body).map((i) => [i.line, i.item, i.group])).toEqual([
      [2, 'onions', undefined],
      [4, 'tomatoes', 'For the sauce'],
      [5, 'cumin', 'For the sauce'],
    ]);
    expect(ingredients('No sections here')).toEqual([]);
  });

  it('reads the Method as steps', () => {
    expect(methodSteps(body)).toEqual([
      'Soften the onions.',
      'Add the sauce.',
      'Crack in the eggs.',
    ]);
  });

  it('writes a body from parts, and a skeleton', () => {
    const made = recipeBody({
      ingredients: ['2 onions', '### Sauce', '- 400 g tomatoes'],
      method: ['Soften the onions.', '2. Add tomatoes.'],
      notes: 'From Ottolenghi.',
    });
    expect(made).toBe(
      [
        '## Ingredients',
        '',
        '- 2 onions',
        '### Sauce',
        '- 400 g tomatoes',
        '',
        '## Method',
        '',
        '1. Soften the onions.',
        '2. Add tomatoes.',
        '',
        '## Notes',
        '',
        'From Ottolenghi.',
        '',
      ].join('\n'),
    );
    expect(ingredients(made).map((i) => i.item)).toEqual(['onions', 'tomatoes']);
    // A group heading in the method is not a numbered step.
    expect(recipeBody({ ingredients: [], method: ['### Dough', 'Mix.', 'Knead.'] })).toContain(
      '### Dough\n1. Mix.\n2. Knead.',
    );
    expect(recipeSkeleton()).toBe('## Ingredients\n\n## Method\n\n## Notes\n');
  });
});

describe('importing (#128)', () => {
  it('names a recipe after its site until the page is read', () => {
    const url = 'https://www.example.com/dal?x=1';
    expect(importPlaceholder(url)).toBe('Recipe from example.com');
    expect(importPlaceholder(url, 3)).toBe('Recipe from example.com (3)');
    expect(isImportPlaceholder('Recipe from example.com', url)).toBe(true);
    expect(isImportPlaceholder('Recipe from example.com (12)', url)).toBe(true);
    expect(isImportPlaceholder('Recipe from example.com, mine', url)).toBe(false);
    expect(isImportPlaceholder('Dal', url)).toBe(false);
    expect(importPlaceholder('not a url')).toBe('Recipe from a link');
  });

  it('knows a skeleton nobody has written in', () => {
    expect(untouchedRecipe(recipeSkeleton())).toBe(true);
    expect(untouchedRecipe('## Ingredients\n## Method\n\n## Notes')).toBe(true);
    expect(untouchedRecipe(recipeSkeleton() + 'a note')).toBe(false);
  });
});
