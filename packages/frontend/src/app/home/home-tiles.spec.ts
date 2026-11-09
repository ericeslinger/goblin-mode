import { arrange, moveBy, nearestSlot } from './home-tiles';

const ALL = ['notes', 'kitchen', 'reader', 'reading', 'assistants', 'map'];

describe('arrange (#222)', () => {
  it('is the default order with nothing arranged', () => {
    expect(arrange({ order: [], hidden: [] }, ALL)).toEqual({ shown: ALL, off: [] });
  });

  it('keeps the order, drops tiles that cannot show, and adds missing ones at the end', () => {
    expect(
      arrange({ order: ['map', 'gone', 'kitchen', 'map'], hidden: ['reader'] }, [
        'notes',
        'reader',
        'reading',
        'map',
      ]),
    ).toEqual({ shown: ['map', 'notes', 'reading'], off: ['reader'] });
  });
});

describe('moveBy', () => {
  it('moves a tile and refuses to go past either end', () => {
    expect(moveBy(['a', 'b', 'c'], 'c', -2)).toEqual(['c', 'a', 'b']);
    expect(moveBy(['a', 'b', 'c'], 'a', -1)).toBeUndefined();
    expect(moveBy(['a', 'b', 'c'], 'b', 2)).toBeUndefined();
  });
});

describe('nearestSlot', () => {
  it('picks the slot whose centre is nearest', () => {
    const slots = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 110, y: 0, w: 100, h: 100 },
      { x: 0, y: 110, w: 100, h: 100 },
    ];
    expect(nearestSlot(slots, 190, 20)).toBe(1);
    expect(nearestSlot(slots, 40, 300)).toBe(2);
  });
});
