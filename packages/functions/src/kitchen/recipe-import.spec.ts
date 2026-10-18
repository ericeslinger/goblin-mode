import { describe, expect, it, vi } from 'vitest';
import { recipeFromReply } from './claude-recipe-reader';
import { readRecipe, recipeFromJsonLd } from './recipe-import';

const ld = (data: unknown) =>
  `<html><head><title>Dal | Site</title><script type="application/ld+json">${JSON.stringify(
    data,
  )}</script></head><body><p>A long story.</p></body></html>`;

const page =
  (html: string, contentType = 'text/html; charset=utf-8') =>
  async () => ({
    contentType,
    bytes: new TextEncoder().encode(html),
  });

describe('recipeFromJsonLd (#128)', () => {
  it('reads a Recipe in a @graph, with sections of steps and a yield', () => {
    const html = ld({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'Dal' },
        {
          '@type': ['Recipe'],
          name: 'Red lentil dal &amp; rice',
          recipeYield: ['4', '4 servings'],
          recipeIngredient: ['1 cup red lentils', ' 2 cloves <b>garlic</b>, minced ', ''],
          recipeInstructions: [
            {
              '@type': 'HowToSection',
              name: 'The dal',
              itemListElement: [
                { '@type': 'HowToStep', text: 'Rinse the lentils.' },
                { '@type': 'HowToStep', text: 'Simmer 20 minutes.' },
              ],
            },
            { '@type': 'HowToStep', name: 'Serve.' },
          ],
        },
      ],
    });
    expect(recipeFromJsonLd(html)).toEqual({
      name: 'Red lentil dal & rice',
      ingredients: ['1 cup red lentils', '2 cloves garlic, minced'],
      method: ['### The dal', 'Rinse the lentils.', 'Simmer 20 minutes.', 'Serve.'],
      servings: 4,
    });
  });

  it('reads instructions given as one string, and skips broken JSON', () => {
    const html =
      '<script type="application/ld+json">{oops</script>' +
      ld({
        '@type': 'Recipe',
        name: 'Toast',
        recipeIngredient: ['bread'],
        recipeInstructions: 'Toast it.\nButter it.',
        recipeYield: 'Serves 2',
      });
    expect(recipeFromJsonLd(html)).toMatchObject({
      method: ['Toast it.', 'Butter it.'],
      servings: 2,
    });
  });

  it('finds nothing on a page without a Recipe', () => {
    expect(recipeFromJsonLd(ld({ '@type': 'Article', name: 'News' }))).toBeUndefined();
    expect(recipeFromJsonLd('<p>no scripts</p>')).toBeUndefined();
  });
});

describe('readRecipe (#128)', () => {
  const dal = { '@type': 'Recipe', name: 'Dal', recipeIngredient: ['lentils'] };

  it('takes the JSON-LD without asking Claude', async () => {
    const extractor = vi.fn();
    const read = await readRecipe('https://x.test/dal', page(ld(dal)), extractor);
    expect(read).toEqual({ name: 'Dal', ingredients: ['lentils'], method: [] });
    expect(extractor).not.toHaveBeenCalled();
  });

  it("falls back to Claude on the page's text, and says when there is no recipe", async () => {
    const extractor = vi.fn(async () => ({ name: 'Soup', ingredients: ['water'], method: [] }));
    const html = '<title>Soup</title><script>x()</script><p>Water.</p>';
    await expect(readRecipe('https://x.test/s', page(html), extractor)).resolves.toMatchObject({
      name: 'Soup',
    });
    expect(extractor).toHaveBeenCalledWith({
      url: 'https://x.test/s',
      title: 'Soup',
      text: expect.stringContaining('Water.'),
    });
    await expect(readRecipe('https://x.test/s', page(html), async () => undefined)).rejects.toThrow(
      'no recipe found on the page',
    );
    await expect(readRecipe('https://x.test/s', page(html), null)).rejects.toThrow(
      'no recipe found on the page',
    );
  });

  it('refuses what is not a web page', async () => {
    await expect(
      readRecipe('https://x.test/a.pdf', page('%PDF-', 'application/pdf'), null),
    ).rejects.toThrow('not a web page (application/pdf)');
  });
});

describe('recipeFromReply (#128)', () => {
  it("reads Claude's structured reply", () => {
    const reply = JSON.stringify({
      found: true,
      name: ' Soup ',
      servings: 0,
      ingredients: ['water', ' '],
      method: ['Boil.'],
    });
    expect(recipeFromReply(reply)).toEqual({
      name: 'Soup',
      ingredients: ['water'],
      method: ['Boil.'],
    });
    expect(
      recipeFromReply(
        JSON.stringify({ found: false, name: '', servings: 0, ingredients: [], method: [] }),
      ),
    ).toBeUndefined();
  });
});
