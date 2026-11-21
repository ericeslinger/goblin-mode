// Habits (#324, Eric 2026-11-21; DESIGN.md, Habits): the pure logic the
// app, the assistant's tools and the nudges share. Which habits are due
// on a day, whether a day or period is done or skipped, the streak and
// the seven-day strip. Days are calendar dates, YYYY-MM-DD, in the time
// zone of whoever asks (`zonedDay(now, tz)` in reminders.ts gives
// today); everything here is calendar arithmetic on them, so a clock
// change never moves a day. Weeks start on `HabitsConfig.weekStart`,
// Monday unless set, in the Kitchen's way (`periodStartFor`).
import { z } from 'zod';
import { WEEKDAYS, type Weekday, addDays, periodStartFor } from './mealplan';
import type { Habit, HabitEntry, HabitLog } from './model';

/**
 * The Habits module's configuration, in `settings/modules`
 * (habits.config), defaults filling gaps: the day a week starts on,
 * Monday as the meal plan's default.
 */
export const HabitsConfig = z.object({
  weekStart: z.enum(WEEKDAYS).catch('Mon').default('Mon'),
});
export type HabitsConfig = z.infer<typeof HabitsConfig>;

/** The module's configuration from whatever is stored. */
export function habitsConfig(raw: unknown): HabitsConfig {
  const parsed = HabitsConfig.safeParse(raw && typeof raw === 'object' ? raw : {});
  return parsed.success ? parsed.data : HabitsConfig.parse({});
}

/** The month a day is in, YYYY-MM. */
export function habitMonth(day: string): string {
  return day.slice(0, 7);
}

/** The key a log keeps a day under: its day of the month, "01" to "31". */
export function habitDayKey(day: string): string {
  return day.slice(8, 10);
}

/** A month log's id, derived: `{habitId}_{YYYY-MM}`. */
export function habitLogId(habitId: string, month: string): string {
  return `${habitId}_${month}`;
}

/** The habit and month a log id names; undefined if it names none. */
export function parseHabitLogId(id: string): { habit: string; month: string } | undefined {
  const m = /^([A-Za-z0-9-]{1,64})_(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(id);
  return m ? { habit: m[1], month: m[2] } : undefined;
}

/** Every check-in in `logs`, by day (YYYY-MM-DD). */
export function habitEntries(
  logs: readonly Pick<HabitLog, 'month' | 'days'>[],
): Map<string, HabitEntry> {
  const out = new Map<string, HabitEntry>();
  for (const log of logs) {
    for (const [key, entry] of Object.entries(log.days)) {
      if (entry) out.set(`${log.month}-${key}`, entry);
    }
  }
  return out;
}

/** A period of a habit's schedule: its first and last day. */
export interface HabitPeriod {
  start: string;
  end: string;
}

/** The period holding `day`: the day, its week, or its month. */
export function habitPeriod(
  schedule: Habit['schedule'],
  day: string,
  weekStart: Weekday = 'Mon',
): HabitPeriod {
  if (schedule === 'daily') return { start: day, end: day };
  if (schedule === 'weekly') {
    const start = periodStartFor(day, weekStart);
    return { start, end: addDays(start, 6) };
  }
  const month = habitMonth(day);
  const [y, m] = month.split('-').map(Number);
  // Day 0 of the next month is this month's last.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}

/** The period just before `period` on the same schedule. */
function previousPeriod(
  schedule: Habit['schedule'],
  period: HabitPeriod,
  weekStart: Weekday,
): HabitPeriod {
  return habitPeriod(schedule, addDays(period.start, -1), weekStart);
}

/**
 * How a period stands: done when any day in it is done, else skipped
 * when any is skipped, else nothing (`none`). Only days from `from` to
 * `until` are looked at, the whole period unless given.
 */
function stateBetween(
  entries: ReadonlyMap<string, HabitEntry>,
  from: string,
  until: string,
): 'done' | 'skipped' | 'none' {
  let skipped = false;
  for (let d = from; d <= until; d = addDays(d, 1)) {
    const state = entries.get(d)?.state;
    if (state === 'done') return 'done';
    if (state === 'skipped') skipped = true;
  }
  return skipped ? 'skipped' : 'none';
}

/** How the period holding `day` stands: done, skipped, or nothing yet. */
export function habitPeriodState(
  habit: Pick<Habit, 'schedule'>,
  entries: ReadonlyMap<string, HabitEntry>,
  day: string,
  weekStart: Weekday = 'Mon',
): 'done' | 'skipped' | 'none' {
  const { start, end } = habitPeriod(habit.schedule, day, weekStart);
  return stateBetween(entries, start, end);
}

/**
 * Whether a habit is on the list for `day`: never when archived; a
 * daily one every day; a weekly or monthly one on every day of its
 * period until the day it is done or skipped, that day included (so it
 * shows ticked), and not after.
 */
export function habitDue(
  habit: Pick<Habit, 'schedule' | 'archived'>,
  entries: ReadonlyMap<string, HabitEntry>,
  day: string,
  weekStart: Weekday = 'Mon',
): boolean {
  if (habit.archived) return false;
  if (habit.schedule === 'daily') return true;
  const { start } = habitPeriod(habit.schedule, day, weekStart);
  return start === day || stateBetween(entries, start, addDays(day, -1)) === 'none';
}

/** Whether `day` may be logged on `today`: today, or yesterday after the fact. */
export function canLogHabitDay(day: string, today: string): boolean {
  return day === today || day === addDays(today, -1);
}

/**
 * The months whose logs hold everything the strip ending `today` and
 * the period it starts in need: at most two, as a strip is seven days
 * and its first period begins at most twelve days before today.
 */
export function habitLogMonths(
  schedule: Habit['schedule'],
  today: string,
  weekStart: Weekday = 'Mon',
): string[] {
  const from = habitMonth(habitPeriod(schedule, addDays(today, -6), weekStart).start);
  const to = habitMonth(today);
  return from === to ? [to] : [from, to];
}

/** A streak, and whether the logs given reached back far enough to know it. */
export interface HabitStreak {
  /** Consecutive periods done, skips passed over. */
  count: number;
  /**
   * False when the streak was still running at the first day the logs
   * read cover (`loadedFrom`): read the month before and ask again.
   */
  complete: boolean;
}

/**
 * The streak as of `today` (#324): consecutive periods done, counting
 * back from the period holding today. A skipped period is passed over,
 * neither counted nor breaking it; a period with nothing logged ends
 * it, except the current one, which is not counted against it until it
 * ends, and the one before while it can still be logged (yesterday is
 * in it: for a daily habit yesterday, for a weekly or monthly one the
 * last period only on the first day of the next). A day logged after
 * the fact counts as any other. A weekly
 * habit's streak counts weeks, a monthly one's months. `loadedFrom` is
 * the first day the logs given cover (the first of the earliest month
 * read); none means they are all the history there is.
 */
export function habitStreak(
  habit: Pick<Habit, 'schedule'>,
  entries: ReadonlyMap<string, HabitEntry>,
  today: string,
  options: { weekStart?: Weekday; loadedFrom?: string } = {},
): HabitStreak {
  const weekStart = options.weekStart ?? 'Mon';
  let period = habitPeriod(habit.schedule, today, weekStart);
  const unread = (p: HabitPeriod) =>
    options.loadedFrom !== undefined && p.start < options.loadedFrom;
  if (unread(period)) return { count: 0, complete: false };
  let count = 0;
  // The current period: counted when done, never against.
  if (stateBetween(entries, period.start, period.end) === 'done') count++;
  // Bounded: a skip can only pass over a logged period, so the walk
  // ends at the first period before the earliest check-in.
  const earliest = [...entries.keys()].sort()[0];
  // The period before is spared too while it can still be logged, that
  // is while yesterday is in it (Eric, 2026-11-21): always for a daily
  // habit, for a weekly or monthly one only on a new period's first day.
  let first = true;
  for (;;) {
    period = previousPeriod(habit.schedule, period, weekStart);
    const spared = first && canLogHabitDay(period.end, today);
    first = false;
    if (unread(period)) return { count, complete: false };
    if (!spared && (earliest === undefined || period.end < earliest)) {
      return { count, complete: true };
    }
    const state = stateBetween(entries, period.start, period.end);
    if (state === 'none' && !spared) return { count, complete: true };
    if (state === 'done') count++;
  }
}

/**
 * A day on the seven-day strip: `done` or `skipped` that day;
 * `covered`, a weekly or monthly habit's day in a period settled on
 * another day; `missed`, a day of a period that ended with nothing
 * logged and can no longer be logged; `open`, a day of a period with
 * nothing logged that can still be: the current one, or the one before
 * while yesterday is in it (spared, as the streak spares it, Eric
 * 2026-11-21);
 * `before`, a day before the habit began.
 */
export type HabitDayState = 'done' | 'skipped' | 'covered' | 'missed' | 'open' | 'before';

/**
 * The seven days ending `today`, oldest first, and how each stands.
 * Archived or not alike, as an archived habit's history stays visible.
 * `createdOn` is the day the habit began (its `createdAt` in the
 * asker's zone); days before it are `before`.
 */
export function habitStrip(
  habit: Pick<Habit, 'schedule'>,
  entries: ReadonlyMap<string, HabitEntry>,
  today: string,
  options: { weekStart?: Weekday; createdOn?: string } = {},
): { day: string; state: HabitDayState }[] {
  const weekStart = options.weekStart ?? 'Mon';
  const out: { day: string; state: HabitDayState }[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = addDays(today, -i);
    out.push({ day, state: dayState(habit, entries, day, today, weekStart, options.createdOn) });
  }
  return out;
}

function dayState(
  habit: Pick<Habit, 'schedule'>,
  entries: ReadonlyMap<string, HabitEntry>,
  day: string,
  today: string,
  weekStart: Weekday,
  createdOn: string | undefined,
): HabitDayState {
  const own = entries.get(day)?.state;
  if (own) return own;
  if (createdOn !== undefined && day < createdOn) return 'before';
  const period = habitPeriod(habit.schedule, day, weekStart);
  if (stateBetween(entries, period.start, period.end) !== 'none') return 'covered';
  // Still loggable (its last day is yesterday): open, not yet missed.
  return period.end < today && !canLogHabitDay(period.end, today) ? 'missed' : 'open';
}
