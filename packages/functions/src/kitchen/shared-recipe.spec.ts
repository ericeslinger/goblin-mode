import { describe, expect, it } from 'vitest';
import { renderSharePage } from '../shares/page';
import { recipeFromJsonLd } from './recipe-import';

// A recipe shared as a public copy (2026-11-26) carries schema.org
// Recipe JSON-LD (shares/page.ts); this app’s own
// importer reads it back as it reads any recipe site's.
describe('a shared recipe’s page, read by the recipe importer', () => {
  it('gives back its name, ingredients and steps', () => {
    const html = renderSharePage({
      kind: 'recipe',
      title: 'Potato gratin',
      body:
        '## Ingredients\n\n### For the dish\n- 1 kg potatoes, sliced\n- 300 ml *cream*\n' +
        '- 1 clove [[Garlic]]\n\n## Method\n\n1. Heat the oven to 180C.\n' +
        '2. Layer the potatoes & pour the cream over.\n3. Bake 1 hour.\n\n' +
        '## Notes\n\nGood with </script> salad.',
      source: 'https://recipes.example/gratin',
    });
    expect(recipeFromJsonLd(html)).toEqual({
      name: 'Potato gratin',
      ingredients: ['1 kg potatoes, sliced', '300 ml cream', '1 clove Garlic'],
      method: [
        'Heat the oven to 180C.',
        'Layer the potatoes & pour the cream over.',
        'Bake 1 hour.',
      ],
    });
  });

  it('keeps a hostile name and lines as words, inside the one data block', () => {
    const html = renderSharePage({
      kind: 'recipe',
      title: '</script><script>alert(1)</script>',
      body: '## Ingredients\n\n- 2 eggs <!--\n\n## Method\n\n1. Whisk </script>',
    });
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(recipeFromJsonLd(html)).toEqual({
      // The importer drops tags from what it reads, as from any site.
      name: 'alert(1)',
      ingredients: ['2 eggs <!--'],
      method: ['Whisk'],
    });
  });
});
