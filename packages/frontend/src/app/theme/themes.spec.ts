import {
  type Mode,
  type Palette,
  THEMES,
  THEME_IDS,
  contrast,
  themeById,
  tokensFor,
} from './themes';

const MODES: Mode[] = ['light', 'dark'];

// WCAG 2.1 AA: 4.5 for text, 3 for marks that carry meaning.
const TEXT_PAIRS: [keyof Palette, keyof Palette][] = [
  ['ink', 'bg'],
  ['ink', 'surface'],
  ['quiet', 'bg'],
  ['quiet', 'surface'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['onAccent', 'accent'],
];
const MARK_PAIRS: [keyof Palette, keyof Palette][] = [
  ['good', 'bg'],
  ['warn', 'bg'],
];

describe('themes', () => {
  it('has five themes with distinct ids, in the declared order', () => {
    expect(THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
  });

  it('writes every color as #rrggbb', () => {
    for (const theme of THEMES) {
      for (const mode of MODES) {
        for (const [name, value] of Object.entries(theme[mode])) {
          expect(value, `${theme.id} ${mode} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  for (const theme of THEMES) {
    for (const mode of MODES) {
      it(`${theme.name}, ${mode}: text passes AA and marks reach 3 to 1`, () => {
        const p = theme[mode];
        const failures = [
          ...TEXT_PAIRS.filter(([fg, bg]) => contrast(p[fg], p[bg]) < 4.5),
          ...MARK_PAIRS.filter(([fg, bg]) => contrast(p[fg], p[bg]) < 3),
        ].map(([fg, bg]) => `${fg} on ${bg}: ${contrast(p[fg], p[bg]).toFixed(2)}`);
        expect(failures).toEqual([]);
      });
    }
  }

  it('measures contrast the WCAG way', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('falls back to the default theme for an unknown id', () => {
    expect(themeById('nope').id).toBe('herbarium');
    expect(themeById(undefined).id).toBe('herbarium');
    expect(themeById('pixel').id).toBe('pixel');
  });

  it('gives every theme the same set of tokens', () => {
    const names = Object.keys(tokensFor(THEMES[0], 'light')).sort();
    for (const theme of THEMES) {
      for (const mode of MODES) {
        expect(Object.keys(tokensFor(theme, mode)).sort()).toEqual(names);
      }
    }
  });
});
