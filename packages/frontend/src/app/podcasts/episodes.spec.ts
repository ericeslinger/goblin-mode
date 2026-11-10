import { episodeState, initials, stateText, tint, totalText } from './episodes';

describe('an episode’s state (#245)', () => {
  it('is New until heard, Started once a place is kept, Heard once played', () => {
    expect(episodeState({})).toBe('new');
    expect(episodeState({ position: 0 })).toBe('new');
    expect(episodeState({ position: 754 })).toBe('started');
    expect(episodeState({ position: 754, played: true })).toBe('heard');
    expect(episodeState({ played: true })).toBe('heard');
  });

  it('says notes read beside New or Started, and changes no state for it', () => {
    expect(stateText({ read: false })).toBe('New');
    expect(stateText({ read: true })).toBe('New, notes read');
    expect(episodeState({ read: true } as never)).toBe('new');
    expect(stateText({ read: true, position: 30 })).toBe('Started, notes read');
    expect(stateText({ read: false, position: 30 })).toBe('Started');
    // Heard reads its notes too, as the player marks it; nothing more to say.
    expect(stateText({ read: true, played: true })).toBe('Heard');
  });

  it('gives a show’s initials and a tint of its own', () => {
    expect(initials('Kiln talk')).toBe('KT');
    expect(initials('Dice & paper')).toBe('DP');
    expect(initials('radiolab')).toBe('R');
    expect(initials('  ')).toBe('?');
    expect(tint('p1')).toBe(tint('p1'));
    for (const id of ['a', 'b', 'p1', 'feed-xyz']) {
      expect(tint(id)).toBeGreaterThanOrEqual(14);
      expect(tint(id)).toBeLessThanOrEqual(32);
    }
  });
});

describe('a total of listening time (#251)', () => {
  it('reads as words, with no leading zero on the minutes', () => {
    expect(totalText(4 * 3600 + 7 * 60)).toBe('4 h 7 min');
    expect(totalText(4 * 3600 + 17 * 60)).toBe('4 h 17 min');
    expect(totalText(2 * 3600)).toBe('2 h');
    expect(totalText(42 * 60)).toBe('42 min');
    expect(totalText(10)).toBe('1 min');
  });
});
