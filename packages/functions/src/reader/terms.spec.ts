import { describe, expect, it } from 'vitest';
import { TERMS_MAX, queryTerms, rarestTerm, stem, termsOf, termsOfItem } from './terms';

describe('the word index (#175)', () => {
  it('stems plurals, -ed and -ing to one term, and leaves short words alone', () => {
    for (const w of ['glaze', 'glazes', 'glazed', 'glazing']) expect(stem(w)).toBe('glaz');
    expect(stem('chairs')).toBe('chair');
    expect(stem('chair')).toBe('chair');
    expect(stem('stories')).toBe(stem('story'));
    expect(stem('carried')).toBe('carry');
    expect(stem('boxes')).toBe('box');
    expect(stem('matches')).toBe('match');
    expect(stem('glasses')).toBe('glass');
    expect(stem('running')).toBe('run');
    expect(stem('runs')).toBe('run');
    expect(stem('falling')).toBe('fall');
    expect(stem('missed')).toBe('miss');
    expect(stem('analysis')).toBe('analysis');
    expect(stem('string')).toBe('string');
    expect(stem('need')).toBe('need');
    expect(stem('bus')).toBe('bus');
    expect(stem('1990s')).toBe('1990s');
  });

  it('reads the title, then the text: lowercase, distinct, stop words out', () => {
    expect(termsOf('Three chairs', 'A look at three chairs worth sitting in. One, two.')).toEqual([
      'thre',
      'chair',
      'look',
      'worth',
      'sit',
      'one',
      'two',
    ]);
  });

  it('keeps accents as letters, and numbers as words', () => {
    expect(termsOf('Café crème', 'Über 2026 Ångström naïve')).toEqual([
      'café',
      'crèm',
      'über',
      '2026',
      'ångström',
      'naïv',
    ]);
    // The same word decomposed is the same term.
    expect(termsOf('', 'café')).toEqual(['café']);
    expect(termsOf('', '東京 タワー')).toEqual(['東京', 'タワー']);
  });

  it('drops one-letter and over-long tokens, link targets and addresses', () => {
    const long = 'x'.repeat(41);
    expect(termsOf('', `a b ${long} ok`)).toEqual(['ok']);
    expect(
      termsOf('', 'See [the kiln](https://kiln.example/firing) or https://other.example/page'),
    ).toEqual(['see', 'kiln']);
    // A page's escaped markdown is still its words.
    expect(termsOf('', 'price\\_list \\*now\\* \\#tag don’t')).toEqual([
      'pric',
      'list',
      'now',
      'tag',
      'dont',
    ]);
  });

  it('caps a long text, first seen first', () => {
    const text = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
    const terms = termsOf('Title', text);
    expect(terms).toHaveLength(TERMS_MAX);
    expect(terms[0]).toBe('titl');
    expect(terms[1]).toBe('word0');
    expect(terms.at(-1)).toBe('word198');
    expect(termsOf('', text, 3)).toEqual(['word0', 'word1', 'word2']);
  });

  it('reads a query as an item, and asks the index for the longest term', () => {
    expect(queryTerms('Celadon GLAZES')).toEqual(['celadon', 'glaz']);
    expect(queryTerms('the of and')).toEqual([]);
    expect(rarestTerm(['glaz', 'celadon', 'kiln'])).toBe('celadon');
    expect(rarestTerm(['kiln', 'pots'])).toBe('kiln');
    expect(rarestTerm([])).toBeUndefined();
  });

  it('indexes a stored item from its title, the page’s text, then the feed’s', () => {
    expect(termsOfItem({ title: 'Kilns', content: 'short feed text' })).toEqual([
      'kiln',
      'short',
      'feed',
      'text',
    ]);
    expect(
      termsOfItem({ title: 'Kilns', content: 'feed text', readerContent: 'the full essay' }),
    ).toEqual(['kiln', 'full', 'essay', 'feed', 'text']);
    expect(termsOfItem({ title: 7, content: null })).toEqual([]);
  });
});
