import { describe, expect, it } from 'vitest';
import { suggestRecipes } from './suggest';

const recipe = (id: string, title: string, items: string[]) => ({
  id,
  title,
  body: `## Ingredients\n\n${items.map((i) => `- ${i}`).join('\n')}\n`,
});

describe('suggestRecipes (#132)', () => {
  const recipes = [
    recipe('dal', 'Dal', ['1 cup lentils', 'limes']),
    recipe('soup', 'Soup', ['2 onions', '1 l stock', 'salt']),
    recipe('toast', 'Toast', ['bread']),
    recipe('stew', 'Stew', ['2 onions', 'beef']),
    { id: 'empty', title: 'Fish of the week', body: '## Ingredients\n\n## Method\n' },
  ];
  const have = new Set(['lentils', 'limes', 'onions', 'beef']);

  it('ranks by what is on hand, then by how long since made', () => {
    const made = new Map([
      ['stew', ['2026-09-01']],
      ['dal', ['2026-10-01']],
    ]);
    const out = suggestRecipes(recipes, made, have, '2026-10-19');
    expect(out.map((s) => s.title)).toEqual(['Stew', 'Dal', 'Soup', 'Toast']);
    expect(out[0]).toEqual({
      id: 'stew',
      title: 'Stew',
      onHand: 2,
      total: 2,
      missing: [],
      lastMade: '2026-09-01',
    });
    expect(out[2]).toMatchObject({ onHand: 1, total: 3, missing: ['stock', 'salt'] });
  });

  it('leaves out what was made in the last week, and keeps to the limit', () => {
    const made = new Map([['stew', ['2026-10-15']]]);
    const out = suggestRecipes(recipes, made, have, '2026-10-19', 2);
    expect(out.map((s) => s.title)).toEqual(['Dal', 'Soup']);
  });
});
