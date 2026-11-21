import { addDays } from '@mossgoblin/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  HABIT_STREAK_MONTHS,
  type HabitMonthRead,
  findHabit,
  habitToday,
  previousMonth,
  readHabitDays,
  streakReadBack,
} from './habits';
import { ToolError } from './tool-error';

const at = { seconds: 1, nanoseconds: 0 };

describe('the Habits tools’ pure parts (#324 step 3)', () => {
  it('reads a month log entry by entry, as the app does', () => {
    expect(
      readHabitDays(
        {
          days: {
            '01': { state: 'done', at },
            '02': { state: 'maybe', at },
            '31': { state: 'done', at },
            x: { state: 'done', at },
            '03': { state: 'skipped', at, answer: 'plain' },
          },
        },
        '2026-11',
      ),
    ).toEqual({ '01': { state: 'done', at } });
    expect(readHabitDays(undefined, '2026-11')).toEqual({});
  });

  it('steps back a month, across a year', () => {
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-03')).toBe('2026-02');
  });

  it('gives today in the habit’s zone, or nothing for a zone it does not know', () => {
    const ms = Date.parse('2026-11-21T06:00:00Z');
    expect(habitToday(ms, 'America/Los_Angeles')).toBe('2026-11-20');
    expect(habitToday(ms, 'Europe/Paris')).toBe('2026-11-21');
    expect(habitToday(ms, 'Not/AZone')).toBeUndefined();
  });

  it('finds a habit by id, else by its name with case and spacing aside', () => {
    const list = [
      { id: 'a', habit: { name: 'Floss', archived: true } },
      { id: 'b', habit: { name: 'Floss', archived: false } },
      { id: 'c', habit: { name: 'Drink metamucil', archived: false } },
    ];
    expect(findHabit(list, 'c').id).toBe('c');
    expect(findHabit(list, '  drink  METAMUCIL ').id).toBe('c');
    // An unarchived one before an archived one of the same name.
    expect(findHabit(list, 'floss').id).toBe('b');
    expect(() => findHabit(list, 'Run')).toThrow(ToolError);
    expect(() => findHabit(list, 'Run')).toThrow(/no habit Run; list_habits names them/);
    const twice = [...list, { id: 'd', habit: { name: 'floss', archived: false } }];
    expect(() => findHabit(twice, 'Floss')).toThrow(/2 habits are named Floss/);
  });

  /** Daily logs with every day from `from` to `to` done. */
  function doneBetween(from: string, to: string): Map<string, HabitMonthRead> {
    const out = new Map<string, HabitMonthRead>();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const month = d.slice(0, 7);
      const log = out.get(month) ?? { month, days: {} };
      log.days[d.slice(8)] = { state: 'done', at };
      out.set(month, log);
    }
    return out;
  }
  const reader = (logs: Map<string, HabitMonthRead>) =>
    vi.fn(async (months: string[]) => months.map((m) => logs.get(m) ?? { month: m, days: {} }));
  const first = (logs: Map<string, HabitMonthRead>, months: string[]) =>
    months.map((m) => logs.get(m) ?? { month: m, days: {} });

  it('reads back past a month boundary while the streak still runs', async () => {
    // Done every day since Oct 20; today is Nov 3, the strip's months.
    const logs = doneBetween('2026-10-20', '2026-11-03');
    const readMore = reader(logs);
    const streak = await streakReadBack({ schedule: 'daily' }, '2026-11-03', {
      weekStart: 'Mon',
      read: first(logs, ['2026-10', '2026-11']),
      readMore,
    });
    expect(streak).toEqual({ count: 15, capped: false });
    expect(readMore).not.toHaveBeenCalled();
    // From Sep 25 it runs past the first month read: one read back.
    const longer = doneBetween('2026-09-25', '2026-11-03');
    const more = reader(longer);
    expect(
      await streakReadBack({ schedule: 'daily' }, '2026-11-03', {
        weekStart: 'Mon',
        read: first(longer, ['2026-10', '2026-11']),
        readMore: more,
      }),
    ).toEqual({ count: 40, capped: false });
    expect(more).toHaveBeenCalledTimes(1);
  });

  it('reads no further back than the month the habit began', async () => {
    const logs = doneBetween('2026-10-01', '2026-11-03');
    const readMore = reader(logs);
    expect(
      await streakReadBack({ schedule: 'daily' }, '2026-11-03', {
        weekStart: 'Mon',
        createdOn: '2026-10-01',
        read: first(logs, ['2026-10', '2026-11']),
        readMore,
      }),
    ).toEqual({ count: 34, capped: false });
    expect(readMore).not.toHaveBeenCalled();
  });

  it('stops at the cap and says so', async () => {
    const logs = doneBetween('2023-01-01', '2026-11-03');
    const readMore = reader(logs);
    const streak = await streakReadBack({ schedule: 'daily' }, '2026-11-03', {
      weekStart: 'Mon',
      read: first(logs, ['2026-11']),
      readMore,
    });
    expect(streak.capped).toBe(true);
    // The 24 months from Dec 2024 to Nov 2026, every day done.
    const days = (Date.parse('2026-11-03') - Date.parse('2024-12-01')) / 86_400_000 + 1;
    expect(streak.count).toBe(days);
    const asked = readMore.mock.calls.flatMap(([m]) => m);
    expect(asked.length + 1).toBe(HABIT_STREAK_MONTHS);
  });
});
