import { bedGrid, beds, lanes, plant, type MapNote } from './garden';

const n = (id: string, over: Partial<MapNote> = {}): MapNote => ({
  id,
  title: id,
  kind: 'text',
  links: [],
  body: 'text',
  ...over,
});

const notes = [
  n('c-kiln', { kind: 'concept', title: 'Kiln', body: '' }),
  n('c-glaze', { kind: 'concept', title: 'Glaze', body: '' }),
  n('c-idle', { kind: 'concept', title: 'Idle', body: '' }),
  n('a', { links: ['c-glaze', 'c-kiln'], createdAt: 30 }),
  n('b', { links: ['c-kiln'], createdAt: 10 }),
  n('c', { links: ['c-kiln'], createdAt: 20 }),
  n('d', { createdAt: 5 }),
  n('empty', { body: ' ', links: ['c-glaze'] }),
  n('gone', { archived: true, links: ['c-glaze'] }),
];

describe('beds', () => {
  it('plants each note once, in its most-linked concept’s bed', () => {
    expect(beds(notes).map((b) => [b.title, b.notes.map((x) => x.id)])).toEqual([
      ['Kiln', ['a', 'b', 'c']],
      ['Glaze', []],
      ['Idle', []],
      ['Not linked yet', ['d']],
    ]);
  });
});

describe('lanes', () => {
  it('runs each bed oldest first, folds the overflow, and filters to one', () => {
    expect(lanes(notes)[0].notes.map((x) => x.note.id)).toEqual(['b', 'c', 'a']);
    const two = lanes(notes, 2);
    expect(two.map((l) => l.title)).toEqual(['Kiln', 'Everything else']);
    expect(two[1].notes.map((x) => x.note.id)).toEqual(['d']);
    expect(lanes(notes, 6, 'c-kiln').map((l) => l.id)).toEqual(['c-kiln']);
    // Filtered, a lane holds every note linking it, planted there or not.
    const glaze = lanes(notes, 6, 'c-glaze');
    expect(glaze.map((l) => [l.id, l.notes.map((x) => x.note.id)])).toEqual([['c-glaze', ['a']]]);
  });
});

describe('geometry', () => {
  it('lays beds on a square-ish grid and plants notes in rings', () => {
    expect(bedGrid(4, 100).map(({ x, y }) => [x, y])).toEqual([
      [50, 50],
      [150, 50],
      [50, 150],
      [150, 150],
    ]);
    const first = plant(0, 0, 0);
    expect(first.x).toBeCloseTo(0);
    expect(first.y).toBeCloseTo(-55);
    expect(Math.hypot(plant(8, 0, 0).x, plant(8, 0, 0).y)).toBeCloseTo(90);
  });
});
