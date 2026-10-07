import { radial } from './layout';

describe('radial', () => {
  it('puts the center in the middle and each ring at its radius', () => {
    const placed = radial(
      [
        { id: 'c', hop: 0 },
        { id: 'a', hop: 1 },
        { id: 'b', hop: 1 },
        { id: 'x', hop: 2, via: 'a' },
      ],
      100,
    );
    const at = (id: string) => placed.find((p) => p.id === id)!;
    expect(at('c')).toMatchObject({ x: 50, y: 50 });
    // The first inner note is straight up; the other opposite it.
    expect(at('a').x).toBeCloseTo(50);
    expect(at('a').y).toBeCloseTo(25);
    expect(at('b').y).toBeCloseTo(75);
    // A far note sits out beyond the inner note it came through.
    expect(at('x').x).toBeCloseTo(50);
    expect(at('x').y).toBeCloseTo(8);
  });

  it('is the same every time', () => {
    const nodes = [
      { id: 'c', hop: 0 as const },
      { id: 'a', hop: 1 as const },
      { id: 'x', hop: 2 as const, via: 'a' },
      { id: 'y', hop: 2 as const, via: 'a' },
    ];
    expect(radial(nodes)).toEqual(radial(nodes));
  });
});
