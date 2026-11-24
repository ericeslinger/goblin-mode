import { describe, expect, it } from 'vitest';
import {
  HABIT_NUDGE_LATE_MS,
  canLogHabitDay,
  habitDayKey,
  habitDayLoggable,
  habitDue,
  habitEntries,
  habitLogId,
  habitLogMonths,
  habitMonth,
  habitPeriod,
  habitPeriodCount,
  habitPeriodState,
  habitSettledOn,
  habitTimes,
  habitStreak,
  habitNextNudge,
  habitNudgeAt,
  habitNudgeDue,
  habitNudgePlan,
  habitNudgeTime,
  habitStrip,
  habitZone,
  habitsConfig,
  lastWeekday,
  parseHabitLogId,
} from './habits';
import { HABIT_DAY_KEYS, Habit, type HabitEntry, HabitLog } from './model';
import { zonedDay } from './reminders';
import { habitAnswerAadFor, newDataKey, openText, sealText } from './sealed';

const stamp = { seconds: 1, nanoseconds: 0 };
const done: HabitEntry = { state: 'done', at: stamp };
const skipped: HabitEntry = { state: 'skipped', at: stamp };

/** Check-ins by day, from `{ '2026-11-20': done, ... }`. */
const log = (days: Record<string, HabitEntry>) => new Map(Object.entries(days));
/** Each day in `days` done. */
const doneOn = (...days: string[]) => log(Object.fromEntries(days.map((d) => [d, done])));

const daily = { schedule: 'daily', archived: false } as const;
const weekly = { schedule: 'weekly', archived: false } as const;
const monthly = { schedule: 'monthly', archived: false } as const;
const archivedDaily = { ...daily, archived: true };

const habit = (over: Record<string, unknown> = {}) => ({
  name: 'Stretch',
  schedule: 'daily',
  time: '11:00',
  tz: 'America/Los_Angeles',
  answer: 'done',
  nudge: true,
  archived: false,
  createdAt: stamp,
  updatedAt: stamp,
  createdBy: 'user',
  ...over,
});

describe('a habit’s stored shape (#324)', () => {
  it('takes each schedule and answer kind, with what each needs', () => {
    expect(Habit.safeParse(habit()).success).toBe(true);
    expect(Habit.safeParse(habit({ schedule: 'weekly' })).success).toBe(true);
    expect(
      Habit.safeParse(habit({ schedule: 'monthly', time: undefined, nudge: false })).success,
    ).toBe(true);
    expect(Habit.safeParse(habit({ answer: 'text' })).success).toBe(true);
    expect(
      Habit.safeParse(habit({ answer: 'choice', choices: ['calm', 'tense', 'tired'] })).success,
    ).toBe(true);
    expect(Habit.safeParse(habit({ answer: 'note', template: 'feelings' })).success).toBe(true);
    expect(Habit.safeParse(habit({ createdBy: 'claude', agent: 'Claude' })).success).toBe(true);
  });

  it('refuses what does not fit', () => {
    expect(Habit.safeParse(habit({ schedule: 'fortnightly' })).success).toBe(false);
    expect(Habit.safeParse(habit({ answer: 'number' })).success).toBe(false);
    expect(Habit.safeParse(habit({ name: '' })).success).toBe(false);
    expect(Habit.safeParse(habit({ name: 'x'.repeat(81) })).success).toBe(false);
    expect(Habit.safeParse(habit({ name: 'x'.repeat(80) })).success).toBe(true);
    expect(Habit.safeParse(habit({ time: '24:00' })).success).toBe(false);
    expect(Habit.safeParse(habit({ time: '9:00' })).success).toBe(false);
    // A nudge goes at the habit's time, so it needs one.
    expect(Habit.safeParse(habit({ time: undefined })).success).toBe(false);
    // Choices with, and only with, a choice answer: two to twelve, each once.
    expect(Habit.safeParse(habit({ answer: 'choice' })).success).toBe(false);
    expect(Habit.safeParse(habit({ choices: ['a', 'b'] })).success).toBe(false);
    expect(Habit.safeParse(habit({ answer: 'choice', choices: ['a'] })).success).toBe(false);
    const twelve = Array.from({ length: 12 }, (_, i) => `mood ${i}`);
    expect(Habit.safeParse(habit({ answer: 'choice', choices: twelve })).success).toBe(true);
    expect(Habit.safeParse(habit({ answer: 'choice', choices: [...twelve, 'x'] })).success).toBe(
      false,
    );
    expect(Habit.safeParse(habit({ answer: 'choice', choices: ['a', 'a'] })).success).toBe(false);
    expect(
      Habit.safeParse(habit({ answer: 'choice', choices: ['a', 'x'.repeat(41)] })).success,
    ).toBe(false);
    // A template with, and only with, a note answer.
    expect(Habit.safeParse(habit({ answer: 'note' })).success).toBe(false);
    expect(Habit.safeParse(habit({ template: 'feelings' })).success).toBe(false);
  });
});

describe('a month’s check-ins (#324)', () => {
  const uid = 'owner';
  const id = habitLogId('h1', '2026-11');

  it('derives and reads the id', () => {
    expect(id).toBe('h1_2026-11');
    expect(parseHabitLogId(id)).toEqual({ habit: 'h1', month: '2026-11' });
    expect(parseHabitLogId('feelings-lunch_2026-02')).toEqual({
      habit: 'feelings-lunch',
      month: '2026-02',
    });
    expect(parseHabitLogId('h1_2026-13')).toBeUndefined();
    expect(parseHabitLogId('h_1_2026-11')).toBeUndefined();
    expect(habitMonth('2026-11-21')).toBe('2026-11');
    expect(habitDayKey('2026-11-01')).toBe('01');
    expect(HABIT_DAY_KEYS).toHaveLength(31);
    expect(HABIT_DAY_KEYS[0]).toBe('01');
    expect(HABIT_DAY_KEYS[30]).toBe('31');
  });

  it('keys days by the day of the month, only days the month has', () => {
    const base = { habit: 'h1', month: '2026-02', updatedAt: stamp };
    expect(HabitLog.safeParse({ ...base, days: {} }).success).toBe(true);
    expect(HabitLog.safeParse({ ...base, days: { '28': done } }).success).toBe(true);
    expect(HabitLog.safeParse({ ...base, days: { '29': done } }).success).toBe(false);
    expect(HabitLog.safeParse({ ...base, month: '2028-02', days: { '29': done } }).success).toBe(
      true,
    );
    expect(HabitLog.safeParse({ ...base, days: { '1': done } }).success).toBe(false);
    expect(HabitLog.safeParse({ ...base, days: { '32': done } }).success).toBe(false);
    const all = Object.fromEntries(HABIT_DAY_KEYS.map((k) => [k, done]));
    expect(HabitLog.safeParse({ ...base, month: '2026-12', days: all }).success).toBe(true);
    expect(HabitLog.safeParse({ ...base, month: '2026-11', days: all }).success).toBe(false);
    expect(HabitLog.safeParse({ ...base, habit: 'h_1', days: {} }).success).toBe(false);
    expect(HabitLog.safeParse({ ...base, month: '2026-2', days: {} }).success).toBe(false);
  });

  it('holds an answer sealed only, to its day, and a skip holds none', () => {
    const key = newDataKey();
    const answer = sealText(key, habitAnswerAadFor(uid, id, '21'), 'calm');
    const base = { habit: 'h1', month: '2026-11', updatedAt: stamp };
    const day = (entry: object) => HabitLog.safeParse({ ...base, days: { '21': entry } }).success;
    expect(day({ ...done, answer })).toBe(true);
    expect(day({ ...done, noteId: 'n1' })).toBe(true);
    expect(day({ ...done, answer: 'calm' })).toBe(false);
    expect(day({ ...done, answer, noteId: 'n1' })).toBe(false);
    expect(day({ ...skipped, answer })).toBe(false);
    expect(day({ ...skipped, noteId: 'n1' })).toBe(false);
    expect(day({ state: 'ticked', at: stamp })).toBe(false);
    expect(day({ state: 'done' })).toBe(false);
    expect(openText(key, habitAnswerAadFor(uid, id, '21'), answer)).toBe('calm');
    // Bound to the day, the log and the user.
    expect(() => openText(key, habitAnswerAadFor(uid, id, '20'), answer)).toThrow();
    expect(() => openText(key, habitAnswerAadFor(uid, 'h1_2026-10', '21'), answer)).toThrow();
    expect(() => openText(key, habitAnswerAadFor('other', id, '21'), answer)).toThrow();
    expect(() => habitAnswerAadFor(uid, id, '32')).toThrow(RangeError);
  });

  it('reads the check-ins of several months by day', () => {
    const entries = habitEntries([
      { month: '2026-10', days: { '31': done } },
      { month: '2026-11', days: { '01': skipped } },
    ]);
    expect([...entries.keys()]).toEqual(['2026-10-31', '2026-11-01']);
    expect(entries.get('2026-11-01')).toEqual(skipped);
  });
});

describe('periods and weeks (#324)', () => {
  it('starts a week on Monday unless configured', () => {
    const quiet = { quietFrom: '22:00', quietTo: '06:00' };
    expect(habitsConfig(undefined)).toEqual({ weekStart: 'Mon', ...quiet });
    expect(habitsConfig({ weekStart: 'Sun' })).toEqual({ weekStart: 'Sun', ...quiet });
    expect(habitsConfig({ weekStart: 'Someday' })).toEqual({ weekStart: 'Mon', ...quiet });
  });

  it('finds the day, the week and the month', () => {
    expect(habitPeriod('daily', '2026-11-21')).toEqual({ start: '2026-11-21', end: '2026-11-21' });
    // 2026-11-21 is a Saturday.
    expect(habitPeriod('weekly', '2026-11-21')).toEqual({ start: '2026-11-16', end: '2026-11-22' });
    expect(habitPeriod('weekly', '2026-11-21', 'Sun')).toEqual({
      start: '2026-11-15',
      end: '2026-11-21',
    });
    // A week across the year's end.
    expect(habitPeriod('weekly', '2026-12-31')).toEqual({ start: '2026-12-28', end: '2027-01-03' });
    expect(habitPeriod('monthly', '2026-11-21')).toEqual({
      start: '2026-11-01',
      end: '2026-11-30',
    });
    expect(habitPeriod('monthly', '2028-02-10')).toEqual({
      start: '2028-02-01',
      end: '2028-02-29',
    });
    expect(habitPeriod('monthly', '2026-12-31')).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
    });
  });

  it('settles a period by a done, else a skip, anywhere in it', () => {
    const entries = log({ '2026-11-17': skipped, '2026-11-19': done });
    expect(habitPeriodState(weekly, entries, '2026-11-16')).toBe('done');
    expect(habitPeriodState(daily, entries, '2026-11-17')).toBe('skipped');
    expect(habitPeriodState(daily, entries, '2026-11-18')).toBe('none');
    expect(habitPeriodState(weekly, log({ '2026-11-17': skipped }), '2026-11-22')).toBe('skipped');
  });

  it('names the months a strip needs: one, or two across a month’s start', () => {
    expect(habitLogMonths('daily', '2026-11-21')).toEqual(['2026-11']);
    expect(habitLogMonths('daily', '2026-11-03')).toEqual(['2026-10', '2026-11']);
    // The strip starts on Tuesday 2026-11-10, in a week from Monday the 9th.
    expect(habitLogMonths('weekly', '2026-11-16')).toEqual(['2026-11']);
    // The strip starts on 2026-11-01, a Sunday, in a week from 2026-10-26.
    expect(habitLogMonths('weekly', '2026-11-07')).toEqual(['2026-10', '2026-11']);
    expect(habitLogMonths('monthly', '2027-01-02')).toEqual(['2026-12', '2027-01']);
  });

  it('logs today, or yesterday after the fact, and no further back', () => {
    expect(canLogHabitDay('2026-11-21', '2026-11-21')).toBe(true);
    expect(canLogHabitDay('2026-11-20', '2026-11-21')).toBe(true);
    expect(canLogHabitDay('2026-11-19', '2026-11-21')).toBe(false);
    expect(canLogHabitDay('2026-11-22', '2026-11-21')).toBe(false);
    expect(canLogHabitDay('2026-12-31', '2027-01-01')).toBe(true);
  });
});

describe('habitDue (#324)', () => {
  it('lists a daily habit every day, done or not', () => {
    expect(habitDue(daily, log({}), '2026-11-21')).toBe(true);
    expect(habitDue(daily, doneOn('2026-11-21'), '2026-11-21')).toBe(true);
  });

  it('never lists an archived habit', () => {
    expect(habitDue(archivedDaily, log({}), '2026-11-21')).toBe(false);
    expect(habitDue({ ...weekly, archived: true }, log({}), '2026-11-21')).toBe(false);
  });

  it('lists a weekly habit each day of the week until the day it is done', () => {
    const entries = doneOn('2026-11-18'); // Wednesday
    expect(habitDue(weekly, entries, '2026-11-16')).toBe(true);
    expect(habitDue(weekly, entries, '2026-11-18')).toBe(true);
    expect(habitDue(weekly, entries, '2026-11-19')).toBe(false);
    expect(habitDue(weekly, entries, '2026-11-22')).toBe(false);
    // The next week it is back.
    expect(habitDue(weekly, entries, '2026-11-23')).toBe(true);
    // A skip settles the week as a done does.
    expect(habitDue(weekly, log({ '2026-11-16': skipped }), '2026-11-17')).toBe(false);
  });

  it('lists a monthly habit until done in the month, across the year', () => {
    const entries = doneOn('2026-12-30');
    expect(habitDue(monthly, entries, '2026-12-01')).toBe(true);
    expect(habitDue(monthly, entries, '2026-12-31')).toBe(false);
    expect(habitDue(monthly, entries, '2027-01-01')).toBe(true);
  });
});

describe('habitStreak (#324)', () => {
  const today = '2026-11-21';

  it('is nothing for an empty history', () => {
    expect(habitStreak(daily, log({}), today)).toEqual({ count: 0, complete: true });
    expect(habitStreak(weekly, log({}), today)).toEqual({ count: 0, complete: true });
  });

  it('counts consecutive days, today only once done', () => {
    const entries = doneOn('2026-11-18', '2026-11-19', '2026-11-20');
    expect(habitStreak(daily, entries, today).count).toBe(3);
    entries.set(today, done);
    expect(habitStreak(daily, entries, today).count).toBe(4);
  });

  it('ends at a day with nothing logged, once that day is over', () => {
    const entries = doneOn('2026-11-17', '2026-11-18', '2026-11-20');
    expect(habitStreak(daily, entries, today)).toEqual({ count: 1, complete: true });
  });

  it('spares yesterday while it can still be logged (2026-11-21)', () => {
    // The morning before yesterday is logged: the streak holds.
    expect(habitStreak(daily, doneOn('2026-11-18', '2026-11-19'), today)).toEqual({
      count: 2,
      complete: true,
    });
    // Yesterday logged after the fact: it counts.
    expect(habitStreak(daily, doneOn('2026-11-18', '2026-11-19', '2026-11-20'), today).count).toBe(
      3,
    );
    // Today and yesterday both counted once done.
    expect(habitStreak(daily, doneOn('2026-11-19', '2026-11-20', '2026-11-21'), today).count).toBe(
      3,
    );
    // Two days empty, yesterday and the day before: ended.
    expect(habitStreak(daily, doneOn('2026-11-18'), today)).toEqual({ count: 0, complete: true });
    // The day after, yesterday's chance is gone: 19 and 20 empty end it.
    expect(habitStreak(daily, doneOn('2026-11-18', '2026-11-19'), '2026-11-22').count).toBe(0);
    // An empty history, yesterday spared or not, is nothing.
    expect(habitStreak(daily, log({}), today)).toEqual({ count: 0, complete: true });
  });

  it('spares last week only on the first day of the next (2026-11-21)', () => {
    // Weeks from Monday: Nov 2 done on the 4th, Nov 9 on the 10th, Nov 16 nothing.
    const entries = doneOn('2026-11-04', '2026-11-10');
    // Monday the 23rd: Sunday the 22nd, last week's last day, can still be logged.
    expect(habitStreak(weekly, entries, '2026-11-23')).toEqual({ count: 2, complete: true });
    // Logged after the fact on the Monday, it counts.
    expect(
      habitStreak(weekly, doneOn('2026-11-04', '2026-11-10', '2026-11-22'), '2026-11-23').count,
    ).toBe(3);
    // Tuesday the 24th: last week is over and empty.
    expect(habitStreak(weekly, entries, '2026-11-24')).toEqual({ count: 0, complete: true });
    // Saturday the 21st, mid-week: the week from Nov 16 is current, spared as ever.
    expect(habitStreak(weekly, entries, today).count).toBe(2);
    // Weeks from Sunday: Sunday the 22nd is a new week's first day.
    expect(
      habitStreak(weekly, doneOn('2026-11-10'), '2026-11-22', { weekStart: 'Sun' }).count,
    ).toBe(1);
  });

  it('spares last month only on the first day of the next (2026-11-21)', () => {
    const entries = doneOn('2026-09-15', '2026-10-15');
    // December 1st: November 30th can still be logged.
    expect(habitStreak(monthly, entries, '2026-12-01')).toEqual({ count: 2, complete: true });
    expect(
      habitStreak(monthly, doneOn('2026-09-15', '2026-10-15', '2026-11-30'), '2026-12-01').count,
    ).toBe(3);
    // December 2nd: November is over and empty.
    expect(habitStreak(monthly, entries, '2026-12-02')).toEqual({ count: 0, complete: true });
    // Across the year: January 1st spares December.
    expect(habitStreak(monthly, doneOn('2026-11-03'), '2027-01-01').count).toBe(1);
    expect(habitStreak(monthly, doneOn('2026-11-03'), '2027-01-02').count).toBe(0);
  });

  it('counts yesterday logged after the fact as any other day', () => {
    const late: HabitEntry = { state: 'done', at: { seconds: 1_795_000_000, nanoseconds: 0 } };
    const entries = doneOn('2026-11-18', '2026-11-19');
    entries.set('2026-11-20', late);
    expect(habitStreak(daily, entries, today).count).toBe(3);
  });

  it('passes over a skip in the middle, neither counting it nor breaking', () => {
    const entries = log({
      '2026-11-16': done,
      '2026-11-17': done,
      '2026-11-18': skipped,
      '2026-11-19': done,
      '2026-11-20': done,
    });
    expect(habitStreak(daily, entries, today).count).toBe(4);
    // Skipping today passes over it too.
    entries.set(today, skipped);
    expect(habitStreak(daily, entries, today).count).toBe(4);
    // Only skips: nothing counted.
    expect(habitStreak(daily, log({ '2026-11-20': skipped }), today).count).toBe(0);
  });

  it('runs across a month’s and a year’s end, from two logs', () => {
    const entries = habitEntries([
      { month: '2026-12', days: { '30': done, '31': done } },
      { month: '2027-01', days: { '01': done } },
    ]);
    expect(habitStreak(daily, entries, '2027-01-02')).toEqual({ count: 3, complete: true });
    expect(habitStreak(daily, entries, '2027-01-01')).toEqual({ count: 3, complete: true });
  });

  it('counts weeks for a weekly habit, a week across two months from two logs', () => {
    // Weeks from Monday: Oct 19, Oct 26 (to Nov 1), Nov 2, Nov 9, Nov 16.
    const entries = habitEntries([
      { month: '2026-10', days: { '21': done } },
      { month: '2026-11', days: { '01': done, '04': skipped, '12': done } },
    ]);
    // This week (from Nov 16) has nothing yet and is not counted against.
    expect(habitStreak(weekly, entries, today)).toEqual({ count: 3, complete: true });
    // With only November read, the week from Oct 26 is half unread.
    expect(habitStreak(weekly, entries, today, { loadedFrom: '2026-11-01' })).toEqual({
      count: 1,
      complete: false,
    });
    // Weeks from Sunday: Nov 1 starts its own week, Oct 25 to 31 has nothing.
    expect(habitStreak(weekly, entries, today, { weekStart: 'Sun' })).toEqual({
      count: 2,
      complete: true,
    });
  });

  it('counts months for a monthly habit', () => {
    const entries = doneOn('2026-09-30', '2026-10-01', '2026-11-05');
    expect(habitStreak(monthly, entries, today).count).toBe(3);
    expect(habitStreak(monthly, doneOn('2026-09-30', '2026-11-05'), today).count).toBe(1);
  });

  it('says when the logs read do not reach back far enough', () => {
    const entries = doneOn('2026-10-31', '2026-11-01', '2026-11-02');
    expect(habitStreak(daily, entries, '2026-11-02', { loadedFrom: '2026-11-01' })).toEqual({
      count: 2,
      complete: false,
    });
    expect(habitStreak(daily, entries, '2026-11-02', { loadedFrom: '2026-10-01' })).toEqual({
      count: 3,
      complete: true,
    });
  });

  it('is the same for an archived habit: its history stands', () => {
    const entries = doneOn('2026-11-19', '2026-11-20');
    expect(habitStreak(archivedDaily, entries, today).count).toBe(2);
  });
});

describe('habitStrip (#324)', () => {
  const today = '2026-11-21';
  const states = (strip: { state: string }[]) => strip.map((d) => d.state);

  it('shows seven days, oldest first, each as logged', () => {
    const entries = log({ '2026-11-16': done, '2026-11-18': skipped, '2026-11-20': done });
    const strip = habitStrip(daily, entries, today);
    expect(strip.map((d) => d.day)).toEqual([
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
    ]);
    expect(states(strip)).toEqual([
      'missed',
      'done',
      'missed',
      'skipped',
      'missed',
      'done',
      'open',
    ]);
  });

  it('reads an empty day as open while it can still be logged, then missed', () => {
    const entries = doneOn('2026-11-18');
    // Yesterday (the 20th) is empty but can still be logged.
    expect(states(habitStrip(daily, entries, today)).slice(-3)).toEqual(['missed', 'open', 'open']);
    // A day on, the 20th can no longer be logged.
    expect(states(habitStrip(daily, entries, '2026-11-22')).slice(-4)).toEqual([
      'missed',
      'missed',
      'open',
      'open',
    ]);
  });

  it('shows the days before a habit began as before, unless logged', () => {
    const entries = doneOn('2026-11-19');
    expect(states(habitStrip(daily, entries, today, { createdOn: '2026-11-20' }))).toEqual([
      'before',
      'before',
      'before',
      'before',
      'done', // yesterday, logged after the fact on the day it was made
      'open', // yesterday, empty, can still be logged
      'open',
    ]);
  });

  it('covers a weekly habit’s week once it is done or skipped', () => {
    // From Sunday 2026-11-15, the last day of the week from Nov 9, done
    // on the 10th; then the week from Nov 16, done on Wednesday the 18th.
    const entries = doneOn('2026-11-10', '2026-11-18');
    expect(states(habitStrip(weekly, entries, today))).toEqual([
      'covered',
      'covered',
      'covered',
      'done',
      'covered',
      'covered',
      'covered',
    ]);
    // Nothing yet this week: its days so far are open; last week's missed.
    expect(states(habitStrip(weekly, log({}), '2026-11-18'))).toEqual([
      'missed',
      'missed',
      'missed',
      'missed',
      'open',
      'open',
      'open',
    ]);
    // On Monday the 16th, last week (to Sunday the 15th) can still be
    // logged through yesterday: its empty days are open, not missed.
    expect(states(habitStrip(weekly, log({}), '2026-11-16'))).toEqual([
      'open',
      'open',
      'open',
      'open',
      'open',
      'open',
      'open',
    ]);
    // On the Tuesday it can no longer be: missed; this week's are open.
    expect(states(habitStrip(weekly, log({}), '2026-11-17'))).toEqual([
      'missed',
      'missed',
      'missed',
      'missed',
      'missed',
      'open',
      'open',
    ]);
  });

  it('keeps an archived habit’s history', () => {
    const strip = habitStrip(archivedDaily, doneOn('2026-11-20'), today);
    expect(strip[5]).toEqual({ day: '2026-11-20', state: 'done' });
  });

  it('keeps calendar days through a clock change', () => {
    const la = 'America/Los_Angeles';
    // US clocks fall back at 2026-11-01 02:00 PDT, a 25-hour day.
    expect(zonedDay(Date.parse('2026-11-01T07:30:00Z'), la)).toBe('2026-11-01'); // 00:30 PDT
    expect(zonedDay(Date.parse('2026-11-02T07:30:00Z'), la)).toBe('2026-11-01'); // 23:30 PST
    expect(zonedDay(Date.parse('2026-11-02T08:00:00Z'), la)).toBe('2026-11-02'); // midnight
    // And spring forward, a 23-hour day, in London.
    expect(zonedDay(Date.parse('2027-03-28T22:59:00Z'), 'Europe/London')).toBe('2027-03-28');
    expect(zonedDay(Date.parse('2027-03-28T23:00:00Z'), 'Europe/London')).toBe('2027-03-29');
    const tday = zonedDay(Date.parse('2026-11-04T18:00:00Z'), la);
    const entries = doneOn('2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03');
    const strip = habitStrip(daily, entries, tday);
    expect(strip.map((d) => d.day)).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
    expect(habitStreak(daily, entries, tday).count).toBe(4);
  });
});

describe('weekly and monthly in the app (step 5 of #324, 2026-11-22)', () => {
  const states = (strip: { state: string }[]) => strip.map((d) => d.state);

  it('names the day that settled a period: its first done, else its first skip', () => {
    const entries = log({ '2026-11-17': skipped, '2026-11-19': done, '2026-11-20': done });
    expect(habitSettledOn(weekly, entries, '2026-11-22')).toBe('2026-11-19');
    expect(habitSettledOn(weekly, log({ '2026-11-17': skipped }), '2026-11-16')).toBe('2026-11-17');
    expect(habitSettledOn(weekly, entries, '2026-11-23')).toBeUndefined();
    expect(habitSettledOn(monthly, entries, '2026-11-01')).toBe('2026-11-19');
    expect(habitSettledOn(daily, entries, '2026-11-18')).toBeUndefined();
    // A week across two months, from both months' check-ins.
    const across = habitEntries([{ month: '2026-10', days: { '28': done } }]);
    expect(habitSettledOn(weekly, across, '2026-11-01')).toBe('2026-10-28');
    // It always agrees with how the period stands.
    for (const day of ['2026-11-16', '2026-11-18', '2026-11-23']) {
      const on = habitSettledOn(weekly, entries, day);
      const state = habitPeriodState(weekly, entries, day);
      expect(on === undefined ? 'none' : entries.get(on)?.state).toBe(state);
    }
  });

  it('rereads a daily habit’s ticks as weeks once it is made weekly', () => {
    // Done on most days of three weeks from Monday, none in the week of Nov 2.
    const entries = doneOn(
      '2026-10-27',
      '2026-10-28',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-17',
    );
    const today = '2026-11-19';
    // Daily: today open, yesterday empty and spared, the 17th done, then
    // the 16th empty ends it.
    expect(habitStreak(daily, entries, today).count).toBe(1);
    // Weekly: this week and last week are done, the week of Nov 2 is
    // empty and ends it.
    expect(habitStreak(weekly, entries, today).count).toBe(2);
    // The strip keeps each day ticked, the rest of a done week covered.
    expect(states(habitStrip(weekly, entries, today))).toEqual([
      'covered',
      'covered',
      'covered',
      'covered',
      'done',
      'covered',
      'covered',
    ]);
    // Monthly: November done, October done.
    expect(habitStreak(monthly, entries, today).count).toBe(2);
  });

  it('rereads a weekly habit’s ticks as days once it is made daily', () => {
    // Once a week, on the Wednesday, for three weeks.
    const entries = doneOn('2026-11-04', '2026-11-11', '2026-11-18');
    expect(habitStreak(weekly, entries, '2026-11-20').count).toBe(3);
    // As days: the 19th is empty and no longer loggable on the 21st.
    expect(habitStreak(daily, entries, '2026-11-21').count).toBe(0);
    expect(states(habitStrip(daily, entries, '2026-11-21'))).toEqual([
      'missed',
      'missed',
      'missed',
      'done',
      'missed',
      'open',
      'open',
    ]);
    // Nothing is lost: made weekly again, it reads as it did.
    expect(habitStreak(weekly, entries, '2026-11-20').count).toBe(3);
  });

  it('lists a weekly habit on the day it is settled, never after it in the week', () => {
    // The truthful count for Home (2026-11-22): due and settled on that
    // day, then not due at all, so not counted again that week.
    const entries = log({ '2026-11-17': skipped });
    expect([16, 17, 18, 22].map((d) => habitDue(weekly, entries, `2026-11-${d}`))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(habitPeriodState(weekly, entries, '2026-11-17')).toBe('skipped');
  });
});

describe('which days can be logged (review of #329)', () => {
  const weekly = { schedule: 'weekly' } as const;
  const monthly = { schedule: 'monthly' } as const;

  it('takes today, and yesterday for a daily habit there then', () => {
    expect(habitDayLoggable(daily, '2026-11-21', '2026-11-21')).toBe(true);
    expect(habitDayLoggable(daily, '2026-11-20', '2026-11-21')).toBe(true);
    expect(habitDayLoggable(daily, '2026-11-19', '2026-11-21')).toBe(false);
    expect(habitDayLoggable(daily, '2026-11-22', '2026-11-21')).toBe(false);
  });

  it('never takes a day before the habit began', () => {
    // Made on the 1st: the day before it is not its to log.
    const opts = { createdOn: '2026-11-01' };
    expect(habitDayLoggable(daily, '2026-10-31', '2026-11-01', opts)).toBe(false);
    expect(habitDayLoggable(daily, '2026-11-01', '2026-11-01', opts)).toBe(true);
    expect(habitDayLoggable(daily, '2026-11-01', '2026-11-02', opts)).toBe(true);
  });

  it('takes yesterday for a week or month only when it is a period of its own', () => {
    // 2026-11-16 is a Monday: Sunday the 15th ended last week.
    expect(habitDayLoggable(weekly, '2026-11-15', '2026-11-16')).toBe(true);
    expect(habitDayLoggable(weekly, '2026-11-16', '2026-11-17')).toBe(false);
    expect(habitDayLoggable(weekly, '2026-11-16', '2026-11-17', { weekStart: 'Tue' })).toBe(true);
    expect(habitDayLoggable(monthly, '2026-10-31', '2026-11-01')).toBe(true);
    expect(habitDayLoggable(monthly, '2026-11-20', '2026-11-21')).toBe(false);
    expect(habitDayLoggable(weekly, '2026-11-17', '2026-11-17')).toBe(true);
  });
});

describe('nudges (step 4 of #324; Eric’s decisions, 2026-11-22)', () => {
  const NY = 'America/New_York';
  const config = habitsConfig({});
  const floss = {
    schedule: 'daily',
    time: '21:00',
    tz: NY,
    nudge: true,
    archived: false,
  } as const;
  /** 21:00 in New York on Saturday 2026-11-21 (EST, UTC-5). */
  const AT = Date.parse('2026-11-22T02:00:00Z');
  const on = { on: true, config };

  it('is due at the habit’s time on its day, in its zone', () => {
    expect(habitNudgeAt(floss, '2026-11-21', config)).toBe(AT);
    expect(habitNudgeDue(floss, AT - 1, on)).toBeUndefined();
    expect(habitNudgeDue(floss, AT, on)).toEqual({ day: '2026-11-21', at: AT });
    expect(habitNudgeDue(floss, AT + 60_000, on)).toEqual({ day: '2026-11-21', at: AT });
  });

  it('is not due once the day holds a done or a skip', () => {
    const day = (e: HabitEntry) => ({ ...on, entries: log({ '2026-11-21': e }) });
    expect(habitNudgeDue(floss, AT, day(done))).toBeUndefined();
    expect(habitNudgeDue(floss, AT, day(skipped))).toBeUndefined();
    // Yesterday's entry is another day's: today is still due.
    expect(habitNudgeDue(floss, AT, { ...on, entries: log({ '2026-11-20': done }) })).toEqual({
      day: '2026-11-21',
      at: AT,
    });
  });

  it('is not due archived, with the nudge off, without a time, or with Habits off', () => {
    expect(habitNudgeDue({ ...floss, archived: true }, AT, on)).toBeUndefined();
    expect(habitNudgeDue({ ...floss, nudge: false }, AT, on)).toBeUndefined();
    expect(habitNudgeDue({ ...floss, time: undefined }, AT, on)).toBeUndefined();
    expect(habitNudgeDue(floss, AT, { ...on, on: false })).toBeUndefined();
  });

  it('is sent once: not again for a day already sent, nor an earlier one', () => {
    expect(habitNudgeDue(floss, AT, { ...on, sentFor: '2026-11-21' })).toBeUndefined();
    expect(habitNudgeDue(floss, AT, { ...on, sentFor: '2026-11-22' })).toBeUndefined();
    expect(habitNudgeDue(floss, AT, { ...on, sentFor: '2026-11-20' })).toEqual({
      day: '2026-11-21',
      at: AT,
    });
  });

  it('holds a nudge in the quiet hours to 06:00 the same day', () => {
    expect(habitNudgeTime('03:00', config)).toBe('06:00');
    expect(habitNudgeTime('00:00', config)).toBe('06:00');
    expect(habitNudgeTime('05:59', config)).toBe('06:00');
    expect(habitNudgeTime('06:00', config)).toBe('06:00');
    expect(habitNudgeTime('21:59', config)).toBe('21:59');
    const early = { ...floss, time: '04:30' };
    const six = Date.parse('2026-11-21T11:00:00Z');
    expect(habitNudgeAt(early, '2026-11-21', config)).toBe(six);
    expect(habitNudgeDue(early, Date.parse('2026-11-21T09:30:00Z'), on)).toBeUndefined();
    expect(habitNudgeDue(early, six, on)).toEqual({ day: '2026-11-21', at: six });
  });

  it('sends a time in the quiet hours before midnight as they begin (Eric, 2026-11-22)', () => {
    expect(habitNudgeTime('22:00', config)).toBe('22:00');
    expect(habitNudgeTime('22:30', config)).toBe('22:00');
    expect(habitNudgeTime('23:59', config)).toBe('22:00');
    const late = { ...floss, time: '22:30' };
    const ten = Date.parse('2026-11-22T03:00:00Z'); // 22:00 in New York on the 21st
    expect(habitNudgeAt(late, '2026-11-21', config)).toBe(ten);
    expect(habitNudgeDue(late, ten - 1, on)).toBeUndefined();
    expect(habitNudgeDue(late, ten, on)).toEqual({ day: '2026-11-21', at: ten });
    expect(habitNextNudge(late, AT, config)).toBe(ten);
    expect(habitNextNudge(late, ten, config)).toBe(ten + 24 * 60 * 60_000);
    // A habit timed at 22:00 exactly goes at its own time, the same moment.
    expect(habitNudgeDue({ ...floss, time: '22:00' }, ten, on)).toEqual({
      day: '2026-11-21',
      at: ten,
    });
    // Quiet hours that end before midnight hold to their end that day.
    const noon = habitsConfig({ quietFrom: '12:00', quietTo: '14:00' });
    expect(habitNudgeTime('12:00', noon)).toBe('14:00');
    expect(habitNudgeTime('13:00', noon)).toBe('14:00');
    expect(habitNudgeTime('23:30', noon)).toBe('23:30');
    // Other quiet hours past midnight: 23:00 to 07:00 send 23:45 at 23:00.
    const late23 = habitsConfig({ quietFrom: '23:00', quietTo: '07:00' });
    expect(habitNudgeTime('23:45', late23)).toBe('23:00');
    expect(habitNudgeTime('00:15', late23)).toBe('07:00');
    expect(habitNudgeTime('22:59', late23)).toBe('22:59');
    // None at all when they start where they end.
    expect(habitNudgeTime('23:30', habitsConfig({ quietFrom: '00:00', quietTo: '00:00' }))).toBe(
      '23:30',
    );
  });

  it('catches up a lost wake at the start of the quiet hours for 65 minutes only', () => {
    const late = { ...floss, time: '23:30' };
    const ten = Date.parse('2026-11-22T03:00:00Z'); // 22:00 in New York
    // The hourly run, at 22:40 or at 23:05, still sends it...
    expect(habitNudgeDue(late, ten + 40 * 60_000, on)).toEqual({ day: '2026-11-21', at: ten });
    expect(habitNudgeDue(late, ten + HABIT_NUDGE_LATE_MS, on)).toEqual({
      day: '2026-11-21',
      at: ten,
    });
    // ...and never later than that, deep in the quiet hours.
    expect(habitNudgeDue(late, ten + HABIT_NUDGE_LATE_MS + 1, on)).toBeUndefined();
    // Nor ever past midnight: quiet hours from 23:30 lose it at 00:00.
    const half = habitsConfig({ quietFrom: '23:30', quietTo: '06:00' });
    const t2330 = Date.parse('2026-11-22T04:30:00Z');
    expect(
      habitNudgeDue({ ...floss, time: '23:45' }, t2330 + 29 * 60_000, { on: true, config: half }),
    ).toEqual({
      day: '2026-11-21',
      at: t2330,
    });
    expect(
      habitNudgeDue({ ...floss, time: '23:45' }, t2330 + 31 * 60_000, { on: true, config: half }),
    ).toBeUndefined();
    // Any other nudge is still never sent while it is quiet: a 21:30 one
    // late past 22:00 is let go, as before (review of #330).
    const evening = { ...floss, time: '21:30' };
    expect(habitNudgeDue(evening, ten + 60_000, on)).toBeUndefined();
  });

  it('says what a nudge will do, the one answer for the line, Edit and the assistant', () => {
    const daily = { schedule: 'daily' } as const;
    expect(habitNudgePlan(floss, config)).toEqual({ kind: 'at', time: '21:00', ...daily });
    expect(habitNudgePlan({ ...floss, time: '03:00' }, config)).toEqual({
      kind: 'held',
      time: '06:00',
      ...daily,
    });
    expect(habitNudgePlan({ ...floss, time: '22:00' }, config)).toEqual({
      kind: 'at',
      time: '22:00',
      ...daily,
    });
    expect(habitNudgePlan({ ...floss, time: '23:59' }, config)).toEqual({
      kind: 'early',
      time: '22:00',
      ...daily,
    });
    expect(habitNudgePlan({ ...floss, schedule: 'weekly' }, config)).toEqual({
      kind: 'at',
      time: '21:00',
      schedule: 'weekly',
      lastDay: 'Sun',
    });
    expect(
      habitNudgePlan({ ...floss, schedule: 'weekly' }, habitsConfig({ weekStart: 'Sun' })),
    ).toEqual({ kind: 'at', time: '21:00', schedule: 'weekly', lastDay: 'Sat' });
    expect(habitNudgePlan({ ...floss, schedule: 'monthly', time: '23:00' }, config)).toEqual({
      kind: 'early',
      time: '22:00',
      schedule: 'monthly',
    });
    expect(habitNudgePlan({ ...floss, time: undefined }, config)).toEqual({ kind: 'no-time' });
    expect(habitNudgePlan({ ...floss, time: '' }, config)).toEqual({ kind: 'no-time' });
    expect(habitNudgePlan({ ...floss, nudge: false }, config)).toEqual({ kind: 'off' });
    expect(habitNudgePlan({ ...floss, archived: true }, config)).toEqual({ kind: 'off' });
  });

  it('sends nothing while it is quiet: a 21:30 nudge late past 22:00 is let go', () => {
    const evening = { ...floss, time: '21:30' };
    const at = Date.parse('2026-11-22T02:30:00Z'); // 21:30 in New York on the 21st
    const t2159 = Date.parse('2026-11-22T02:59:00Z');
    const t2200 = Date.parse('2026-11-22T03:00:00Z');
    const t2235 = Date.parse('2026-11-22T03:35:00Z'); // within HABIT_NUDGE_LATE_MS
    expect(habitNudgeDue(evening, t2159, on)).toEqual({ day: '2026-11-21', at });
    expect(habitNudgeDue(evening, t2200, on)).toBeUndefined();
    expect(habitNudgeDue(evening, t2235, on)).toBeUndefined();
    // Held to their end, it goes as they end: 03:00 at 06:00.
    const night = { ...floss, time: '03:00' };
    const six = Date.parse('2026-11-21T11:00:00Z');
    expect(habitNudgeDue(night, six, on)).toEqual({ day: '2026-11-21', at: six });
    // And the wake is for that moment, never one inside them.
    expect(habitNextNudge(evening, at + 60_000, config)).toBe(at + 24 * 60 * 60_000);
    expect(habitNextNudge(night, six - 60 * 60_000, config)).toBe(six);
  });

  it('keeps to quiet hours that do not wrap past midnight', () => {
    const noon = habitsConfig({ quietFrom: '12:00', quietTo: '14:00' });
    const lunch = { ...floss, time: '11:30' };
    const at = Date.parse('2026-11-21T16:30:00Z'); // 11:30 in New York
    const quietOn = { on: true, config: noon };
    expect(habitNudgeDue(lunch, at + 29 * 60_000, quietOn)).toEqual({ day: '2026-11-21', at });
    expect(habitNudgeDue(lunch, at + 30 * 60_000, quietOn)).toBeUndefined(); // 12:00
    expect(habitNudgeDue(lunch, at + 65 * 60_000, quietOn)).toBeUndefined(); // 12:35
    // One in them is held to 14:00 and sent then.
    const two = Date.parse('2026-11-21T19:00:00Z');
    expect(habitNudgePlan({ ...floss, time: '13:00' }, noon)).toEqual({
      kind: 'held',
      time: '14:00',
      schedule: 'daily',
    });
    expect(habitNudgeDue({ ...floss, time: '13:00' }, two, quietOn)).toEqual({
      day: '2026-11-21',
      at: two,
    });
  });

  it('queues no wake where a clock change lands a nudge in the quiet hours', () => {
    // 2026-03-08: New York springs forward at 02:00, so 02:30 lands at
    // 03:30, inside quiet hours of 03:00 to 04:00: no nudge that day.
    const small = habitsConfig({ quietFrom: '03:00', quietTo: '04:00' });
    const early = { ...floss, time: '02:30' };
    expect(habitNudgeAt(early, '2026-03-08', small)).toBeUndefined();
    expect(habitNudgeAt(early, '2026-03-09', small)).toBe(Date.parse('2026-03-09T06:30:00Z'));
  });

  it('never sends a late nudge for a day that has ended, nor one long past', () => {
    // An 21:00 nudge missed all evening: after midnight it is a new day.
    const nextMorning = Date.parse('2026-11-22T05:30:00Z'); // 00:30 on the 22nd
    expect(habitNudgeDue(floss, nextMorning, on)).toBeUndefined();
    // 20:00, so its lateness ends before the quiet hours begin.
    const eight = { ...floss, time: '20:00' };
    const at = AT - 60 * 60_000;
    expect(habitNudgeDue(eight, at + HABIT_NUDGE_LATE_MS, on)).toEqual({ day: '2026-11-21', at });
    expect(habitNudgeDue(eight, at + HABIT_NUDGE_LATE_MS + 1, on)).toBeUndefined();
  });

  it('brings no push for a moment that had passed when the habit was changed', () => {
    expect(habitNudgeDue(floss, AT + 60_000, { ...on, changedAt: AT + 30_000 })).toBeUndefined();
    expect(habitNudgeDue(floss, AT + 60_000, { ...on, changedAt: AT - 30_000 })).toEqual({
      day: '2026-11-21',
      at: AT,
    });
  });

  it('keeps the wall clock across a clock change', () => {
    // 2026-11-01: New York falls back at 02:00. 21:00 that day is EST.
    expect(habitNudgeAt(floss, '2026-10-31', config)).toBe(Date.parse('2026-11-01T01:00:00Z'));
    expect(habitNudgeAt(floss, '2026-11-01', config)).toBe(Date.parse('2026-11-02T02:00:00Z'));
    // 2026-03-08: it springs forward; 06:00 is EDT.
    const early = { ...floss, time: '02:30' };
    expect(habitNudgeAt(early, '2026-03-08', config)).toBe(Date.parse('2026-03-08T10:00:00Z'));
    // With no quiet hours, a time the change skips goes just after the
    // gap, still that day; one it repeats goes the first time.
    const none = habitsConfig({ quietFrom: '00:00', quietTo: '00:00' });
    const skippedAt = habitNudgeAt(early, '2026-03-08', none)!;
    expect(zonedDay(skippedAt, NY)).toBe('2026-03-08');
    expect(skippedAt).toBeGreaterThanOrEqual(Date.parse('2026-03-08T07:00:00Z'));
    expect(habitNudgeAt({ ...floss, time: '01:30' }, '2026-11-01', none)).toBe(
      Date.parse('2026-11-01T05:30:00Z'),
    );
  });

  it('reads the day in the habit’s zone, ahead of UTC or behind it', () => {
    // Tokyo, UTC+9: 07:30 on the 21st is 22:30 UTC on the 20th.
    const tea = { ...floss, time: '07:30', tz: 'Asia/Tokyo' };
    const tokyo = Date.parse('2026-11-20T22:30:00Z');
    expect(habitNudgeDue(tea, tokyo, on)).toEqual({ day: '2026-11-21', at: tokyo });
    // Honolulu, UTC-10: 21:00 on the 21st is 07:00 UTC on the 22nd.
    const walk = { ...floss, tz: 'Pacific/Honolulu' };
    const hnl = Date.parse('2026-11-22T07:00:00Z');
    expect(habitNudgeDue(walk, hnl, on)).toEqual({ day: '2026-11-21', at: hnl });
    expect(habitNudgeDue(walk, hnl, { ...on, sentFor: '2026-11-21' })).toBeUndefined();
  });

  it('nudges nothing in a zone the platform does not know', () => {
    expect(habitNudgeDue({ ...floss, tz: 'Not/AZone' }, AT, on)).toBeUndefined();
    expect(habitNextNudge({ ...floss, tz: 'Not/AZone' }, AT, config)).toBeUndefined();
  });

  it('finds the next nudge to wake for: today’s while ahead, else tomorrow’s', () => {
    expect(habitNextNudge(floss, AT - 60_000, config)).toBe(AT);
    expect(habitNextNudge(floss, AT, config)).toBe(Date.parse('2026-11-23T02:00:00Z'));
    expect(habitNextNudge({ ...floss, nudge: false }, AT, config)).toBeUndefined();
  });
});

describe('weekly and monthly nudges: the last day of the period (Eric, 2026-11-22)', () => {
  const NY = 'America/New_York';
  const config = habitsConfig({});
  const on = { on: true, config };
  const shop = { schedule: 'weekly', time: '21:00', tz: NY, nudge: true, archived: false } as const;
  const rent = { ...shop, schedule: 'monthly' } as const;
  /** 21:00 in New York on Sunday 2026-11-22, the last day of a week from Monday. */
  const SUN = Date.parse('2026-11-23T02:00:00Z');
  /** 21:00 in New York on Saturday 2026-11-21. */
  const SAT = Date.parse('2026-11-22T02:00:00Z');

  it('names the last day of the week by the module’s week start', () => {
    expect(lastWeekday('Mon')).toBe('Sun');
    expect(lastWeekday('Sun')).toBe('Sat');
    expect(lastWeekday('Wed')).toBe('Tue');
  });

  it('nudges a weekly habit on the last day of its week only, at its time', () => {
    expect(habitNudgeAt(shop, '2026-11-22', config)).toBe(SUN);
    expect(habitNudgeAt(shop, '2026-11-21', config)).toBeUndefined();
    expect(habitNudgeAt(shop, '2026-11-16', config)).toBeUndefined();
    expect(habitNudgeDue(shop, SAT, on)).toBeUndefined();
    expect(habitNudgeDue(shop, SUN, on)).toEqual({ day: '2026-11-22', at: SUN });
    // Weeks from Sunday end on Saturday.
    const sunday = { on: true, config: habitsConfig({ weekStart: 'Sun' }) };
    expect(habitNudgeDue(shop, SAT, sunday)).toEqual({ day: '2026-11-21', at: SAT });
    expect(habitNudgeDue(shop, SUN, sunday)).toBeUndefined();
  });

  it('nudges a monthly habit on the last day of months of 28, 29, 30 and 31 days', () => {
    for (const [last, before] of [
      ['2026-02-28', '2026-02-27'],
      ['2028-02-29', '2028-02-28'],
      ['2026-04-30', '2026-04-29'],
      ['2026-01-31', '2026-01-30'],
      ['2026-12-31', '2026-12-30'],
    ]) {
      expect(habitNudgeAt(rent, last, config)).toBeDefined();
      expect(habitNudgeAt(rent, before, config)).toBeUndefined();
    }
    // 2026-11-30, 21:00 EST.
    const end = Date.parse('2026-12-01T02:00:00Z');
    expect(habitNudgeDue(rent, end, on)).toEqual({ day: '2026-11-30', at: end });
    expect(habitNextNudge(rent, Date.parse('2026-11-01T12:00:00Z'), config)).toBe(end);
  });

  it('sends none for a period already done or skipped, any day of it', () => {
    const week = (days: Record<string, HabitEntry>) => ({ ...on, entries: log(days) });
    expect(habitNudgeDue(shop, SUN, week({ '2026-11-17': done }))).toBeUndefined();
    expect(habitNudgeDue(shop, SUN, week({ '2026-11-16': skipped }))).toBeUndefined();
    expect(habitNudgeDue(shop, SUN, week({ '2026-11-22': done }))).toBeUndefined();
    // Last week's tick is last week's.
    expect(habitNudgeDue(shop, SUN, week({ '2026-11-15': done }))).toEqual({
      day: '2026-11-22',
      at: SUN,
    });
    // A week across a month's start reads both months' days.
    const dec6 = Date.parse('2026-12-07T02:00:00Z'); // Sunday 2026-12-06, 21:00 EST
    expect(habitNudgeDue(shop, dec6, on)).toEqual({ day: '2026-12-06', at: dec6 });
    expect(habitNudgeDue(shop, dec6, week({ '2026-11-30': done }))).toBeUndefined();
    const end = Date.parse('2026-12-01T02:00:00Z');
    expect(habitNudgeDue(rent, end, week({ '2026-11-03': skipped }))).toBeUndefined();
  });

  it('is sent once a period, even when the schedule changed within it', () => {
    expect(habitNudgeDue(shop, SUN, { ...on, sentFor: '2026-11-22' })).toBeUndefined();
    // Nudged on Wednesday as a daily habit, then made weekly: none again
    // that week.
    expect(habitNudgeDue(shop, SUN, { ...on, sentFor: '2026-11-18' })).toBeUndefined();
    expect(habitNudgeDue(shop, SUN, { ...on, sentFor: '2026-11-15' })).toEqual({
      day: '2026-11-22',
      at: SUN,
    });
    // Monthly, nudged on the 10th as daily or weekly: none on the 30th.
    const end = Date.parse('2026-12-01T02:00:00Z');
    expect(habitNudgeDue(rent, end, { ...on, sentFor: '2026-11-10' })).toBeUndefined();
    expect(habitNudgeDue(rent, end, { ...on, sentFor: '2026-10-31' })).toEqual({
      day: '2026-11-30',
      at: end,
    });
    // Made daily again the next week: a day each, from its next day.
    const mon = Date.parse('2026-11-24T02:00:00Z'); // Monday 2026-11-23, 21:00
    expect(
      habitNudgeDue({ ...shop, schedule: 'daily' }, mon, { ...on, sentFor: '2026-11-22' }),
    ).toEqual({ day: '2026-11-23', at: mon });
  });

  it('keeps the quiet hours on the last day as on any day', () => {
    // 23:00 on Sunday goes at 22:00; 03:00 at 06:00.
    const ten = Date.parse('2026-11-23T03:00:00Z');
    expect(habitNudgeDue({ ...shop, time: '23:00' }, ten, on)).toEqual({
      day: '2026-11-22',
      at: ten,
    });
    const six = Date.parse('2026-11-22T11:00:00Z');
    expect(habitNudgeDue({ ...shop, time: '03:00' }, six, on)).toEqual({
      day: '2026-11-22',
      at: six,
    });
  });

  it('wakes for the next period’s last day once this one’s has passed', () => {
    expect(habitNextNudge(shop, Date.parse('2026-11-16T15:00:00Z'), config)).toBe(SUN);
    expect(habitNextNudge(shop, SUN, config)).toBe(Date.parse('2026-11-30T02:00:00Z'));
    expect(habitNextNudge(rent, Date.parse('2026-12-01T02:00:00Z'), config)).toBe(
      Date.parse('2027-01-01T02:00:00Z'),
    );
  });

  it('keeps the wall clock on a last day a clock change falls on', () => {
    // Sunday 2026-11-01: New York falls back; 21:00 that evening is EST.
    expect(habitNudgeAt(shop, '2026-11-01', config)).toBe(Date.parse('2026-11-02T02:00:00Z'));
    // Saturday 2026-10-31 ends October: 21:00 EDT.
    expect(habitNudgeAt(rent, '2026-10-31', config)).toBe(Date.parse('2026-11-01T01:00:00Z'));
    // Sunday 2026-03-08 springs forward: 02:30 is skipped, and with no
    // quiet hours it goes just after the gap, still that Sunday.
    const none = habitsConfig({ quietFrom: '00:00', quietTo: '00:00' });
    const at = habitNudgeAt({ ...shop, time: '02:30' }, '2026-03-08', none)!;
    expect(zonedDay(at, NY)).toBe('2026-03-08');
  });
});

describe('the day follows the device (Eric, 2026-11-22)', () => {
  const NY = 'America/New_York';
  const floss = { schedule: 'daily', time: '21:00', tz: NY, nudge: true, archived: false } as const;
  const inZone = (tz?: string) => ({ on: true, config: habitsConfig(tz ? { tz } : {}) });

  it('reads the module’s zone, the habit’s own only while it has none', () => {
    expect(habitZone({ tz: NY }, habitsConfig({ tz: 'Asia/Tokyo' }))).toBe('Asia/Tokyo');
    expect(habitZone({ tz: NY }, habitsConfig({}))).toBe(NY);
    expect(habitZone({ tz: NY }, habitsConfig({ tz: 'Not/AZone' }))).toBe(NY);
    expect(habitsConfig({ tz: 5 })).not.toHaveProperty('tz');
    expect(habitsConfig({ tz: 'x'.repeat(65) }).tz).toBeUndefined();
  });

  it('nudges at the habit’s time where the device last was', () => {
    // 21:00 in Paris on 2026-11-21 is 20:00 UTC.
    const paris = Date.parse('2026-11-21T20:00:00Z');
    expect(habitNudgeDue(floss, paris, inZone('Europe/Paris'))).toEqual({
      day: '2026-11-21',
      at: paris,
    });
    expect(habitNudgeDue(floss, paris, inZone())).toBeUndefined();
  });

  it('eastward across midnight: today moves on, and the new day is nudged once', () => {
    // Nudged at 21:00 in New York on the 21st (02:00 UTC on the 22nd).
    const sent = { sentFor: '2026-11-21' };
    // The device lands in Tokyo, where it is already the 22nd; 21:00
    // there is 12:00 UTC on the 22nd.
    const tokyo = Date.parse('2026-11-22T12:00:00Z');
    expect(habitNudgeDue(floss, tokyo, { ...inZone('Asia/Tokyo'), ...sent })).toEqual({
      day: '2026-11-22',
      at: tokyo,
    });
    // Left New York at 18:00 on the 21st, before its nudge: the 21st is
    // jumped over in Tokyo and never nudged (it can still be logged as
    // yesterday); the 22nd is.
    expect(habitNudgeDue(floss, tokyo, { ...inZone('Asia/Tokyo'), sentFor: '2026-11-20' })).toEqual(
      { day: '2026-11-22', at: tokyo },
    );
  });

  it('westward across midnight: a day already nudged or logged is not again', () => {
    // Nudged at 21:00 in Paris on the 21st, then flown to New York,
    // where 21:00 on the 21st comes again: no second push.
    const ny21 = Date.parse('2026-11-22T02:00:00Z');
    expect(habitNudgeDue(floss, ny21, { ...inZone(NY), sentFor: '2026-11-21' })).toBeUndefined();
    // The next day is nudged as usual.
    expect(
      habitNudgeDue(floss, ny21 + 24 * 60 * 60_000, { ...inZone(NY), sentFor: '2026-11-21' }),
    ).toEqual({ day: '2026-11-22', at: ny21 + 24 * 60 * 60_000 });
    // Nudged for the 22nd in Paris just after midnight (no quiet hours),
    // then back in New York on the 21st: today has gone back a day, and
    // a mark ahead of it holds, so neither the 21st nor the 22nd is
    // nudged again there.
    const none = {
      on: true,
      config: habitsConfig({ tz: NY, quietFrom: '00:00', quietTo: '00:00' }),
    };
    const ahead = { ...none, sentFor: '2026-11-22' };
    expect(habitNudgeDue(floss, ny21, ahead)).toBeUndefined();
    expect(habitNudgeDue(floss, ny21 + 24 * 60 * 60_000, ahead)).toBeUndefined();
    // A day logged in Paris is the same day in New York: logged, no push.
    const morning = { ...floss, time: '08:00' };
    const ny22at8 = Date.parse('2026-11-22T13:00:00Z');
    expect(
      habitNudgeDue(morning, ny22at8, { ...inZone(NY), entries: log({ '2026-11-22': done }) }),
    ).toBeUndefined();
  });

  it('follows the module’s zone through its clock changes', () => {
    // The habit was made in Tokyo, which has none; the device is in New
    // York, which falls back on 2026-11-01: 21:00 there is EST.
    const tea = { ...floss, tz: 'Asia/Tokyo' };
    expect(habitNudgeAt(tea, '2026-11-01', habitsConfig({ tz: NY }))).toBe(
      Date.parse('2026-11-02T02:00:00Z'),
    );
    expect(habitNudgeAt(tea, '2026-10-31', habitsConfig({ tz: NY }))).toBe(
      Date.parse('2026-11-01T01:00:00Z'),
    );
  });
});

describe('N times a week (Eric, 2026-11-23)', () => {
  // Weeks from Monday: 2026-11-16 to 22, 23 to 29, then 11-30 to 12-06.
  const pottery = { schedule: 'weekly', times: 2, archived: false } as const;
  const write = { schedule: 'weekly', times: 3, archived: false } as const;

  it('stores a target of 2 to 7 days, whole, on a weekly habit only', () => {
    for (const times of [2, 3, 7]) {
      expect(Habit.safeParse(habit({ schedule: 'weekly', times })).success).toBe(true);
    }
    expect(Habit.safeParse(habit({ schedule: 'weekly' })).success).toBe(true);
    for (const times of [0, 1, 8, 2.5, '2']) {
      expect(Habit.safeParse(habit({ schedule: 'weekly', times })).success).toBe(false);
    }
    expect(Habit.safeParse(habit({ schedule: 'daily', times: 2 })).success).toBe(false);
    expect(Habit.safeParse(habit({ schedule: 'monthly', times: 2 })).success).toBe(false);
  });

  it('reads the target: a weekly habit’s times, else once', () => {
    expect(habitTimes(pottery)).toBe(2);
    expect(habitTimes(weekly)).toBe(1);
    expect(habitTimes(daily)).toBe(1);
    // Whatever is stored, a month or a day is once.
    expect(habitTimes({ schedule: 'monthly', times: 3 })).toBe(1);
  });

  it('is met when that many days of the week are done, and counts them', () => {
    const one = doneOn('2026-11-17');
    expect(habitPeriodState(pottery, one, '2026-11-20')).toBe('none');
    expect(habitPeriodCount(pottery, one, '2026-11-20')).toEqual({ done: 1, target: 2 });
    expect(habitSettledOn(pottery, one, '2026-11-20')).toBeUndefined();
    const two = doneOn('2026-11-17', '2026-11-19');
    expect(habitPeriodState(pottery, two, '2026-11-20')).toBe('done');
    expect(habitPeriodCount(pottery, two, '2026-11-20')).toEqual({ done: 2, target: 2 });
    // Settled on the day the target was met.
    expect(habitSettledOn(pottery, two, '2026-11-20')).toBe('2026-11-19');
    // Last week's days are last week's.
    expect(habitPeriodCount(pottery, two, '2026-11-23')).toEqual({ done: 0, target: 2 });
    // Once a week, as before: one done day meets it.
    expect(habitPeriodState(weekly, one, '2026-11-20')).toBe('done');
    expect(habitPeriodCount(weekly, one, '2026-11-20')).toEqual({ done: 1, target: 1 });
  });

  it('is due every day of the week until met, again the day after a done day', () => {
    const one = doneOn('2026-11-17');
    expect(habitDue(pottery, one, '2026-11-16')).toBe(true);
    // Done that day: shown done.
    expect(habitDue(pottery, one, '2026-11-17')).toBe(true);
    // Due again while unmet.
    expect(habitDue(pottery, one, '2026-11-18')).toBe(true);
    expect(habitDue(pottery, one, '2026-11-22')).toBe(true);
    const two = doneOn('2026-11-17', '2026-11-19');
    // Met that day: shown done; after it, no longer due.
    expect(habitDue(pottery, two, '2026-11-19')).toBe(true);
    expect(habitDue(pottery, two, '2026-11-20')).toBe(false);
    expect(habitDue(pottery, two, '2026-11-22')).toBe(false);
    // The next week starts afresh.
    expect(habitDue(pottery, two, '2026-11-23')).toBe(true);
    expect(habitDue({ ...pottery, archived: true }, one, '2026-11-18')).toBe(false);
  });

  it('settles the week with a skip, as a weekly habit’s skip does', () => {
    const days = log({ '2026-11-17': done, '2026-11-18': skipped });
    expect(habitPeriodState(pottery, days, '2026-11-18')).toBe('skipped');
    expect(habitSettledOn(pottery, days, '2026-11-20')).toBe('2026-11-18');
    expect(habitDue(pottery, days, '2026-11-18')).toBe(true);
    expect(habitDue(pottery, days, '2026-11-19')).toBe(false);
    // The streak is spared: the week before still counts.
    const spared = log({
      '2026-11-10': done,
      '2026-11-12': done,
      '2026-11-17': done,
      '2026-11-18': skipped,
    });
    expect(habitStreak(pottery, spared, '2026-11-25').count).toBe(1);
  });

  it('shows a done day done, a met week’s other days covered, an unmet past week missed', () => {
    const one = doneOn('2026-11-10', '2026-11-17');
    // Friday 2026-11-20: last week (to the 15th) ended one short of two.
    expect(habitStrip(pottery, one, '2026-11-20').map((d) => d.state)).toEqual([
      'missed', // Sat 14
      'missed', // Sun 15
      'open',
      'done',
      'open',
      'open',
      'open',
    ]);
    const two = doneOn('2026-11-17', '2026-11-19');
    expect(
      habitStrip(pottery, two, '2026-11-20')
        .map((d) => d.state)
        .slice(2),
    ).toEqual(['covered', 'done', 'covered', 'done', 'covered']);
    // Monday: last week, one short, can still be logged as yesterday, so
    // its days stay open, not yet missed.
    expect(habitStrip(pottery, doneOn('2026-11-17'), '2026-11-23').map((d) => d.state)).toEqual(
      // Tue 17 to Mon 23.
      ['done', 'open', 'open', 'open', 'open', 'open', 'open'],
    );
  });

  it('counts weeks met as a streak, across two months, and a week short ends it', () => {
    const days = doneOn(
      '2026-11-24',
      '2026-11-27',
      // The week of 11-30 to 12-06, its two days in two months.
      '2026-11-30',
      '2026-12-02',
      '2026-12-08',
      '2026-12-10',
    );
    // Monday 2026-12-14: this week empty, not counted against.
    expect(habitStreak(pottery, days, '2026-12-14')).toEqual({ count: 3, complete: true });
    // Met this week too.
    const more = new Map([...days, ['2026-12-14', done], ['2026-12-15', done]]);
    expect(habitStreak(pottery, more, '2026-12-15').count).toBe(4);
    // This week one of two: not against it while it can still be met.
    const part = new Map([...days, ['2026-12-14', done]]);
    expect(habitStreak(pottery, part, '2026-12-19').count).toBe(3);
    // A week before with only one done day and no skip is a miss.
    const short = doneOn('2026-11-24', '2026-11-27', '2026-12-02', '2026-12-08', '2026-12-10');
    expect(habitStreak(pottery, short, '2026-12-14').count).toBe(1);
    // As once a week, every one of those weeks counts.
    expect(habitStreak(weekly, short, '2026-12-14').count).toBe(3);
  });

  it('spares last week on the first day of the next, while yesterday can be logged', () => {
    const days = doneOn('2026-11-10', '2026-11-12', '2026-11-17');
    // Monday 2026-11-23: last week one short, yesterday its last day.
    expect(habitStreak(pottery, days, '2026-11-23').count).toBe(1);
    // Tuesday: that chance has gone.
    expect(habitStreak(pottery, days, '2026-11-24').count).toBe(0);
    // Logged yesterday after the fact on the Monday, it counts.
    const late = new Map([...days, ['2026-11-22', done]]);
    expect(habitStreak(pottery, late, '2026-11-23').count).toBe(2);
  });

  it('keeps weeks by the module’s week start (weeks from Sunday)', () => {
    const weekStart = 'Sun' as const;
    // Weeks from Sunday: 2026-11-15 to 21, then 22 to 28.
    const days = doneOn('2026-11-16', '2026-11-21', '2026-11-22');
    expect(habitPeriodState(pottery, days, '2026-11-21', weekStart)).toBe('done');
    expect(habitPeriodCount(pottery, days, '2026-11-23', weekStart)).toEqual({
      done: 1,
      target: 2,
    });
    expect(habitDue(pottery, days, '2026-11-23', weekStart)).toBe(true);
    // From Monday, the 16th and the 21st are one week, the 22nd the same.
    expect(habitPeriodCount(pottery, days, '2026-11-22')).toEqual({ done: 3, target: 2 });
    expect(habitStreak(pottery, days, '2026-11-23', { weekStart }).count).toBe(1);
  });

  it('logs yesterday within the week too, as each day counts, never before it began', () => {
    expect(habitDayLoggable(pottery, '2026-11-18', '2026-11-19')).toBe(true);
    // Once a week, as before: within one week, no.
    expect(habitDayLoggable(weekly, '2026-11-18', '2026-11-19')).toBe(false);
    // At a week’s boundary, both.
    expect(habitDayLoggable(pottery, '2026-11-22', '2026-11-23')).toBe(true);
    expect(habitDayLoggable(weekly, '2026-11-22', '2026-11-23')).toBe(true);
    expect(habitDayLoggable(pottery, '2026-11-18', '2026-11-19', { createdOn: '2026-11-19' })).toBe(
      false,
    );
    expect(habitDayLoggable(pottery, '2026-11-17', '2026-11-19')).toBe(false);
    // Logged on the Monday for the Sunday, it counts for the week before.
    const late = doneOn('2026-11-17', '2026-11-22');
    expect(habitPeriodState(pottery, late, '2026-11-22')).toBe('done');
    expect(habitDue(pottery, late, '2026-11-23')).toBe(true);
  });

  describe('its nudges (a rule of the build’s, Eric’s to overrule)', () => {
    const NY = 'America/New_York';
    const config = habitsConfig({});
    const on = { on: true, config };
    const nudged = { ...write, time: '21:00', tz: NY, nudge: true } as const;
    /** 21:00 in New York, Thursday 19 to Sunday 22 November 2026 (EST). */
    const THU = Date.parse('2026-11-20T02:00:00Z');
    const FRI = Date.parse('2026-11-21T02:00:00Z');
    const SAT = Date.parse('2026-11-22T02:00:00Z');
    const SUN = Date.parse('2026-11-23T02:00:00Z');
    const withDays = (days: Record<string, HabitEntry>, sentFor?: string) => ({
      ...on,
      entries: log(days),
      ...(sentFor ? { sentFor } : {}),
    });

    it('can go on the week’s last three days for three a week, never before', () => {
      expect(habitNudgeAt(nudged, '2026-11-19', config)).toBeUndefined();
      expect(habitNudgeAt(nudged, '2026-11-20', config)).toBe(FRI);
      expect(habitNudgeAt(nudged, '2026-11-22', config)).toBe(SUN);
      expect(habitNudgeDue(nudged, THU, on)).toBeUndefined();
      expect(habitNudgePlan(nudged, config)).toEqual({
        kind: 'at',
        time: '21:00',
        schedule: 'weekly',
        lastDay: 'Sun',
        times: 3,
      });
    });

    it('with none done, nudges on each of the last three days', () => {
      expect(habitNudgeDue(nudged, FRI, withDays({}))).toEqual({ day: '2026-11-20', at: FRI });
      expect(habitNudgeDue(nudged, SAT, withDays({}, '2026-11-20'))).toEqual({
        day: '2026-11-21',
        at: SAT,
      });
      expect(habitNudgeDue(nudged, SUN, withDays({}, '2026-11-21'))).toEqual({
        day: '2026-11-22',
        at: SUN,
      });
    });

    it('with two done by Friday, only on the last day; once met, never', () => {
      const two = { '2026-11-17': done, '2026-11-19': done };
      expect(habitNudgeDue(nudged, FRI, withDays(two))).toBeUndefined();
      expect(habitNudgeDue(nudged, SAT, withDays(two))).toBeUndefined();
      expect(habitNudgeDue(nudged, SUN, withDays(two))).toEqual({ day: '2026-11-22', at: SUN });
      const met = { ...two, '2026-11-21': done };
      expect(habitNudgeDue(nudged, SUN, withDays(met))).toBeUndefined();
      // One done on Saturday: needed two, two days left on Saturday? No:
      // Saturday holds an entry, so none that day; Sunday, one day left
      // and two still needed, it goes.
      const sat = { '2026-11-21': done };
      expect(habitNudgeDue(nudged, SAT, withDays(sat))).toBeUndefined();
      expect(habitNudgeDue(nudged, SUN, withDays(sat))).toEqual({ day: '2026-11-22', at: SUN });
    });

    it('sends none for a day holding an entry, nor a week skipped', () => {
      expect(habitNudgeDue(nudged, FRI, withDays({ '2026-11-20': done }))).toBeUndefined();
      expect(habitNudgeDue(nudged, FRI, withDays({ '2026-11-18': skipped }))).toBeUndefined();
    });

    it('never sends two for one day: the mark stops today and earlier only', () => {
      expect(habitNudgeDue(nudged, FRI, withDays({}, '2026-11-20'))).toBeUndefined();
      // A mark ahead of today (the device went west) holds too.
      expect(habitNudgeDue(nudged, FRI, withDays({}, '2026-11-21'))).toBeUndefined();
      expect(habitNudgeDue(nudged, FRI, withDays({}, '2026-11-19'))).toEqual({
        day: '2026-11-20',
        at: FRI,
      });
      // Once a week, a mark anywhere in the week still stops the Sunday.
      const once = { ...nudged, times: undefined };
      expect(habitNudgeDue(once, SUN, withDays({}, '2026-11-18'))).toBeUndefined();
      expect(habitNudgeDue(once, SUN, withDays({}))).toEqual({ day: '2026-11-22', at: SUN });
    });

    it('wakes for each candidate day in turn', () => {
      expect(habitNextNudge(nudged, Date.parse('2026-11-16T15:00:00Z'), config)).toBe(FRI);
      expect(habitNextNudge(nudged, FRI, config)).toBe(SAT);
      expect(habitNextNudge(nudged, SUN, config)).toBe(Date.parse('2026-11-28T02:00:00Z'));
      // Twice a week: from Saturday.
      expect(
        habitNextNudge({ ...nudged, times: 2 }, Date.parse('2026-11-16T15:00:00Z'), config),
      ).toBe(SAT);
    });
  });
});
