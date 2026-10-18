import { describe, expect, it } from 'vitest';
import {
  FISH_NAME,
  addSlotNote,
  isIsoDate,
  kitchenConfig,
  madeHistory,
  madeLine,
  periodStartFor,
  planBody,
  planId,
  planStartFor,
  planSlots,
  planTitle,
  ratioOf,
  setMade,
  setSlot,
} from './mealplan';

const START = '2026-10-19'; // a Monday

describe('weeks (#129)', () => {
  it('finds the week a day is in, from the configured first day', () => {
    expect(periodStartFor('2026-10-22', 'Mon')).toBe(START);
    expect(periodStartFor(START, 'Mon')).toBe(START);
    expect(periodStartFor('2026-10-25', 'Mon')).toBe(START);
    expect(periodStartFor('2026-10-22', 'Sun')).toBe('2026-10-18');
    expect(planId(START)).toBe('meals-2026-10-19');
    expect(planTitle(START)).toBe('Meals, week of Oct 19');
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
  });

  it('opens an existing plan holding the day, whatever the week now starts on', () => {
    expect(planStartFor('2026-10-22', 'Sun', [START])).toBe(START);
    expect(planStartFor('2026-10-26', 'Sun', [START])).toBe('2026-10-25');
    expect(planStartFor('2026-10-22', 'Mon', [])).toBe(START);
  });

  it('reads a configuration, falling back to the defaults', () => {
    expect(kitchenConfig(undefined)).toEqual({
      weekStart: 'Mon',
      meals: ['dinner'],
      fishDay: 'Thu',
      sections: {},
    });
    expect(kitchenConfig({ weekStart: 'Sun', meals: ['lunch', 'dinner'], fishDay: 'bad' })).toEqual(
      { weekStart: 'Sun', meals: ['lunch', 'dinner'], fishDay: 'Thu', sections: {} },
    );
    expect(kitchenConfig({ groceryList: 'g1', sections: { onion: 'Produce' } })).toMatchObject({
      groceryList: 'g1',
      sections: { onion: 'Produce' },
    });
  });
});

describe('a plan’s text (#129)', () => {
  it('starts with a line a day, the fish on Thursday', () => {
    const body = planBody(START, kitchenConfig({}));
    expect(body.split('\n').slice(0, 6)).toEqual([
      '## Week of Oct 19',
      '',
      '- [ ] Mon dinner:',
      '- [ ] Tue dinner:',
      '- [ ] Wed dinner:',
      `- [ ] Thu dinner: [[${FISH_NAME}]]`,
    ]);
    const sunday = planBody('2026-10-18', kitchenConfig({ weekStart: 'Sun', fishDay: 'Fri' }));
    expect(planSlots(sunday, '2026-10-18').map((s) => `${s.day} ${s.date}`)[0]).toBe(
      'Sun 2026-10-18',
    );
    expect(sunday).toContain('- [ ] Fri dinner: [[Fish of the week]]');
  });

  it('reads slots: recipes, delivery, out, ratios, and the notes under them', () => {
    const body = [
      '## Week of Oct 19',
      '- [x] Mon dinner: [[Shakshuka]] (half recipe)',
      '  - lovely, more chili next time',
      '- [ ] tue Dinner: delivery, Thai',
      '- [ ] Wed dinner: out',
      '- [ ] Thu dinner:',
      '- [ ] Fri dinner: leftovers',
      'not a slot',
    ].join('\n');
    const slots = planSlots(body, START);
    expect(slots.map((s) => [s.day, s.date, s.kind, s.made])).toEqual([
      ['Mon', '2026-10-19', 'recipe', true],
      ['Tue', '2026-10-20', 'delivery', false],
      ['Wed', '2026-10-21', 'out', false],
      ['Thu', '2026-10-22', 'empty', false],
      ['Fri', '2026-10-23', 'other', false],
    ]);
    expect(slots[0]).toMatchObject({
      recipe: 'Shakshuka',
      ratio: 0.5,
      notes: ['lovely, more chili next time'],
      meal: 'dinner',
    });
    expect(slots[1].meal).toBe('dinner');
  });

  it('reads ratios as called out', () => {
    expect(ratioOf('(half recipe)')).toBe(0.5);
    expect(ratioOf('x2')).toBe(2);
    expect(ratioOf('(1.5x)')).toBe(1.5);
    expect(ratioOf('1/3 recipe')).toBeCloseTo(1 / 3);
    expect(ratioOf('for 6 people')).toBeUndefined();
  });

  it('sets a slot, unticking a change and keeping its notes', () => {
    const body = '## Week\n- [x] Mon dinner: [[Dal]]\n  - good\n- [ ] Tue dinner:\n';
    expect(setSlot(body, START, 'Tue', 'dinner', 'delivery')).toBe(
      '## Week\n- [x] Mon dinner: [[Dal]]\n  - good\n- [ ] Tue dinner: delivery\n',
    );
    expect(setSlot(body, START, 'Mon', 'dinner', '[[Soup]]')).toBe(
      '## Week\n- [ ] Mon dinner: [[Soup]]\n  - good\n- [ ] Tue dinner:\n',
    );
    expect(setSlot(body, START, 'Mon', 'dinner', '[[Dal]]')).toBe(body);
    expect(setSlot(body, START, 'Wed', 'lunch', 'out')).toBe(
      '## Week\n- [x] Mon dinner: [[Dal]]\n  - good\n- [ ] Tue dinner:\n- [ ] Wed lunch: out\n',
    );
    expect(setMade(body, START, 'Tue', 'dinner', true)).toContain('- [x] Tue dinner:');
  });

  it('adds a note under a slot, after the ones it has', () => {
    const body = '- [x] Mon dinner: [[Dal]]\n  - good\n- [ ] Tue dinner:';
    expect(addSlotNote(body, START, 'Mon', 'dinner', 'a second\nthought')).toBe(
      '- [x] Mon dinner: [[Dal]]\n  - good\n  - a second thought\n- [ ] Tue dinner:',
    );
  });
});

describe('made history (#129)', () => {
  it('collects the days each recipe was made, from ticked slots', () => {
    const history = madeHistory([
      { periodStart: START, body: '- [x] Mon dinner: [[Dal]]\n- [ ] Tue dinner: [[Dal]]' },
      { periodStart: '2026-10-12', body: '- [x] Fri dinner: [[dal]]' },
      // An overlapping plan (the week's first day changed) counts a day once.
      { periodStart: '2026-10-18', body: '- [x] Mon dinner: [[Dal]]' },
      { body: '- [x] Mon dinner: [[Dal]]' },
    ]);
    expect(history.get('dal')).toEqual(['2026-10-16', '2026-10-19']);
    expect(madeLine(history.get('dal'))).toBe('Made 2 times, last Oct 19');
    expect(madeLine(['2026-10-02'])).toBe('Made once, last Oct 2');
    expect(madeLine(undefined)).toBe('');
  });
});
