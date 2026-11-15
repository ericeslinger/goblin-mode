import { rightNowLine } from './right-now-line';

describe('rightNowLine (#287)', () => {
  it('says how many are due and the first one’s words', () => {
    expect(rightNowLine(['Pick up glazed mugs'])).toBe('1 due · Pick up glazed mugs');
    expect(rightNowLine(['Pick up glazed mugs', 'Call Vikas', 'Water the plants'], 4, 2)).toBe(
      '3 due · Pick up glazed mugs',
    );
  });

  it('with nothing due, says what is new in the Reader and Podcasts', () => {
    expect(rightNowLine([], 3)).toBe('Right Now · 3 new in the Reader');
    expect(rightNowLine([], 0, 2)).toBe('Right Now · 2 new in Podcasts');
    expect(rightNowLine([], 3, 2)).toBe('Right Now · 3 new in the Reader · 2 new in Podcasts');
  });

  it('with nothing at all, is quiet', () => {
    expect(rightNowLine([])).toBe('Right Now · Nothing to tend');
  });
});
