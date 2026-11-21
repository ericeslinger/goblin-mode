import { describe, expect, it } from 'vitest';
import {
  canLogHabitDay,
  habitDayKey,
  habitDue,
  habitEntries,
  habitLogId,
  habitLogMonths,
  habitMonth,
  habitPeriod,
  habitPeriodState,
  habitStreak,
  habitStrip,
  habitsConfig,
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
    expect(habitsConfig(undefined)).toEqual({ weekStart: 'Mon' });
    expect(habitsConfig({ weekStart: 'Sun' })).toEqual({ weekStart: 'Sun' });
    expect(habitsConfig({ weekStart: 'Someday' })).toEqual({ weekStart: 'Mon' });
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
