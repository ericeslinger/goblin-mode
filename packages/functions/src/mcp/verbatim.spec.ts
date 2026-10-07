import { describe, expect, it } from 'vitest';
import { cutsOf, joined } from './verbatim';

const body = 'Kiln day\nFire to cone 6.\n\nGlaze notes\nCeladon ran.\n';

describe('cutsOf', () => {
  it('accepts the note cut at whitespace, in order', () => {
    expect(cutsOf(body, ['Kiln day\nFire to cone 6.', '  Glaze notes\nCeladon ran.'])).toEqual([
      'Kiln day\nFire to cone 6.',
      'Glaze notes\nCeladon ran.',
    ]);
    // Mid-paragraph is fine, as long as nothing is reworded.
    expect(cutsOf(body, ['Kiln day', 'Fire to cone 6.\n\nGlaze notes\nCeladon ran.'])).toHaveLength(
      2,
    );
  });

  it('refuses reworded, reordered, missing or empty parts', () => {
    expect(cutsOf(body, ['Kiln day\nFire to cone six.', 'Glaze notes\nCeladon ran.'])).toBe(
      'part 1 is not the next piece of the note word for word',
    );
    expect(cutsOf(body, ['Glaze notes\nCeladon ran.', 'Kiln day\nFire to cone 6.'])).toMatch(
      /part 1/,
    );
    expect(cutsOf(body, ['Kiln day\nFire to cone 6.'])).toBe(
      'the parts leave out the end of the note',
    );
    expect(cutsOf(body, ['Kiln day', 'Glaze notes\nCeladon ran.'])).toMatch(/part 2/);
    expect(cutsOf(body, [body, ' '])).toBe('every part needs text');
  });
});

describe('joined', () => {
  it('keeps each body whole, a blank line between', () => {
    expect(joined(['A\nb\n', '\nC'])).toBe('A\nb\n\nC');
  });
});
