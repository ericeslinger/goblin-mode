import { SOURCE_HUES, SOURCE_TINT, THEMES, contrast, mixSrgb } from '../theme/themes';
import { sourceMark } from './source-mark';

describe('a feed’s source mark (#288)', () => {
  it('is the first letter or digit of the name, upper case', () => {
    expect(sourceMark('f1', 'kottke.org').letter).toBe('K');
    expect(sourceMark('f1', '🎮 Games weekly').letter).toBe('G');
    expect(sourceMark('f1', '“Quoted” news').letter).toBe('Q');
    expect(sourceMark('f1', '100 Rabbits').letter).toBe('1');
    expect(sourceMark('f1', 'élan').letter).toBe('É');
    expect(sourceMark('f1', '日本のニュース').letter).toBe('日');
    // One character stays one.
    expect(sourceMark('f1', 'ßtraße').letter).toBe('ß');
    // Nothing to draw: a dot.
    expect(sourceMark('f1', '🎮🎲').letter).toBe('•');
    expect(sourceMark('f1', '').letter).toBe('•');
  });

  it('takes its hue from the feed id, the same every time, whatever the name', () => {
    const a = sourceMark('feed-abc', 'Design notes');
    expect(sourceMark('feed-abc', 'Design notes')).toEqual(a);
    expect(sourceMark('feed-abc', 'Renamed').hue).toBe(a.hue);
    expect(a.hue).toBeGreaterThanOrEqual(0);
    expect(a.hue).toBeLessThan(SOURCE_HUES.length);
    // Ids spread over the hues rather than all landing on one.
    const hues = new Set(Array.from({ length: 40 }, (_, n) => sourceMark(`feed-${n}`, 'x').hue));
    expect(hues.size).toBeGreaterThan(4);
  });

  it('keeps its letter at AA on every tint, in every theme and mode', () => {
    const failures: string[] = [];
    for (const theme of THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const { ink, surface } = theme[mode];
        for (const hue of SOURCE_HUES) {
          const ratio = contrast(ink, mixSrgb(hue, surface, SOURCE_TINT));
          if (ratio < 4.5) failures.push(`${theme.id} ${mode} ${hue}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('mixes as color-mix in sRGB does', () => {
    expect(mixSrgb('#ffffff', '#000000', 50)).toBe('#808080');
    expect(mixSrgb('#ff0000', '#0000ff', 0)).toBe('#0000ff');
    expect(mixSrgb('#ff0000', '#0000ff', 100)).toBe('#ff0000');
  });
});
