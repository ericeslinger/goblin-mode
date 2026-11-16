import { NO_DATE, dayKey, dayLabel, groupByDay } from './days';

const NY = 'America/New_York';
// Sunday 15 November 2026, 10:00 in New York (15:00 UTC).
const NOW = Date.parse('2026-11-15T15:00:00Z');

const row = (id: string, at: string | number, read = false) => ({
  id,
  published: typeof at === 'number' ? at : Date.parse(at),
  read,
});

describe('the Reader list by day (#288)', () => {
  it('cuts at local midnight, not at UTC midnight', () => {
    // 00:30 on the 15th in New York is 05:30 UTC; 23:30 on the 14th is 04:30 UTC.
    const days = groupByDay(
      [
        row('a', '2026-11-15T05:30:00Z'),
        row('b', '2026-11-15T04:30:00Z'),
        // 00:30 UTC on the 15th is still the 14th in New York.
        row('c', '2026-11-15T00:30:00Z'),
      ],
      NOW,
      NY,
    );
    expect(days.map((d) => [d.label, d.items.map((i) => i.id)])).toEqual([
      ['Today', ['a']],
      ['Yesterday', ['b', 'c']],
    ]);
    // The same instants in UTC fall the other way.
    expect(
      groupByDay(
        [row('b', '2026-11-15T04:30:00Z'), row('c', '2026-11-14T23:30:00Z')],
        NOW,
        'UTC',
      ).map((d) => d.label),
    ).toEqual(['Today', 'Yesterday']);
  });

  it('names older days by weekday and date, with the year only when it is not this one', () => {
    expect(dayLabel('2026-11-12', '2026-11-15')).toBe('Thursday, Nov 12');
    expect(dayLabel('2025-12-31', '2026-01-02')).toBe('Wednesday, Dec 31, 2025');
    // Yesterday across a month and a year.
    expect(dayLabel('2025-12-31', '2026-01-01')).toBe('Yesterday');
  });

  it('counts each day’s unread, and keeps the list’s order and each day’s start', () => {
    const days = groupByDay(
      [
        row('a', '2026-11-15T14:00:00Z'),
        row('b', '2026-11-15T13:00:00Z', true),
        row('c', '2026-11-13T13:00:00Z', true),
        row('d', '2026-11-12T13:00:00Z'),
        row('e', '2026-11-12T12:00:00Z'),
      ],
      NOW,
      NY,
    );
    expect(days.map((d) => ({ key: d.key, unread: d.unread, start: d.start }))).toEqual([
      { key: '2026-11-15', unread: ['a'], start: 0 },
      // A day with only read rows (Show read): a day, nothing to mark.
      { key: '2026-11-13', unread: [], start: 2 },
      { key: '2026-11-12', unread: ['d', 'e'], start: 3 },
    ]);
    expect(days.flatMap((d) => d.items.map((i) => i.id))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('puts an article with no date under No date, and one from a clock running ahead under Today', () => {
    const days = groupByDay(
      [row('ahead', '2026-11-16T09:00:00Z'), row('a', '2026-11-15T14:00:00Z'), row('z', 0)],
      NOW,
      NY,
    );
    expect(days.map((d) => [d.label, d.items.map((i) => i.id)])).toEqual([
      ['Today', ['ahead', 'a']],
      ['No date', ['z']],
    ]);
    expect(dayKey(Number.NaN, '2026-11-15', NY)).toBe(NO_DATE);
  });

  it('has no days for an empty list', () => {
    expect(groupByDay([], NOW, NY)).toEqual([]);
  });
});
