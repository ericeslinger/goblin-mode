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
import { zonedDay, zonedTime, zonedTimeOn } from './reminders';

/** A time of day, "HH:MM" on a 24-hour clock. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The Habits module's configuration, in `settings/modules`
 * (habits.config), defaults filling gaps: the day a week starts on,
 * Monday as the meal plan's default; and the quiet hours, one setting
 * for every nudge (Eric, 2026-11-21), 22:00 to 06:00 unless set. A
 * start equal to its end means no quiet hours. `tz`, since 2026-11-22
 * (Eric, "follow the device"): the IANA zone of the device the app last
 * ran on with Habits on, written by the app when it differs; the server
 * reads every habit's day in it (`habitZone`). None until the app has
 * written it.
 */
export const HabitsConfig = z.object({
  weekStart: z.enum(WEEKDAYS).catch('Mon').default('Mon'),
  quietFrom: z.string().regex(TIME_OF_DAY).catch('22:00').default('22:00'),
  quietTo: z.string().regex(TIME_OF_DAY).catch('06:00').default('06:00'),
  tz: z.string().min(1).max(64).optional().catch(undefined),
});
export type HabitsConfig = z.infer<typeof HabitsConfig>;

/** The module's configuration from whatever is stored. */
export function habitsConfig(raw: unknown): HabitsConfig {
  const parsed = HabitsConfig.safeParse(raw && typeof raw === 'object' ? raw : {});
  const config = parsed.success ? parsed.data : HabitsConfig.parse({});
  // A zone that did not parse is left out, never kept as undefined: the
  // app writes the parsed config back, and Firestore takes no undefined.
  if (config.tz === undefined) delete config.tz;
  return config;
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

/** The habit fields that decide its periods: its schedule, and a week's target. */
export type HabitTarget = Pick<Habit, 'schedule'> & { times?: number };

/**
 * How many done days settle a period (2026-11-23, "N per week"): a
 * weekly habit's `times`, else one. A monthly or daily habit is always
 * once, whatever is stored.
 */
export function habitTimes(habit: HabitTarget): number {
  return habit.schedule === 'weekly' && habit.times !== undefined && habit.times > 1
    ? habit.times
    : 1;
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
 * How a period stands: done when `target` days in it are done (one,
 * unless a weekly habit's `times` says more), else skipped when any is
 * skipped, else nothing (`none`), which for a target of more than one
 * can hold some done days. Only days from `from` to `until` are looked
 * at, the whole period unless given.
 */
function stateBetween(
  entries: ReadonlyMap<string, HabitEntry>,
  from: string,
  until: string,
  target = 1,
): 'done' | 'skipped' | 'none' {
  let skipped = false;
  let done = 0;
  for (let d = from; d <= until; d = addDays(d, 1)) {
    const state = entries.get(d)?.state;
    if (state === 'done' && ++done >= target) return 'done';
    if (state === 'skipped') skipped = true;
  }
  return skipped ? 'skipped' : 'none';
}

/** How many days from `from` to `until` are done. */
function doneBetween(
  entries: ReadonlyMap<string, HabitEntry>,
  from: string,
  until: string,
): number {
  let done = 0;
  for (let d = from; d <= until; d = addDays(d, 1)) {
    if (entries.get(d)?.state === 'done') done++;
  }
  return done;
}

/**
 * How the period holding `day` stands: done (its target met: a weekly
 * habit's `times` done days, else one), skipped, or not yet.
 */
export function habitPeriodState(
  habit: HabitTarget,
  entries: ReadonlyMap<string, HabitEntry>,
  day: string,
  weekStart: Weekday = 'Mon',
): 'done' | 'skipped' | 'none' {
  const { start, end } = habitPeriod(habit.schedule, day, weekStart);
  return stateBetween(entries, start, end, habitTimes(habit));
}

/**
 * How far the period holding `day` has come (2026-11-23, "N per week"):
 * its done days and its target, "1 of 3 this week". For a habit of one
 * a period, 0 or 1 (more only when more were logged) of 1.
 */
export function habitPeriodCount(
  habit: HabitTarget,
  entries: ReadonlyMap<string, HabitEntry>,
  day: string,
  weekStart: Weekday = 'Mon',
): { done: number; target: number } {
  const { start, end } = habitPeriod(habit.schedule, day, weekStart);
  return { done: doneBetween(entries, start, end), target: habitTimes(habit) };
}

/**
 * The day that settled the period holding `day` (step 5 of #324,
 * 2026-11-22): its first done day, else its first skipped day; none
 * while nothing in it is logged. As `habitPeriodState` decides the
 * period, so the two always agree: for a weekly habit of `times`
 * (2026-11-23), the day its target was met (the third done day of three),
 * else its first skipped day, else none, however many are done.
 */
export function habitSettledOn(
  habit: HabitTarget,
  entries: ReadonlyMap<string, HabitEntry>,
  day: string,
  weekStart: Weekday = 'Mon',
): string | undefined {
  const { start, end } = habitPeriod(habit.schedule, day, weekStart);
  const target = habitTimes(habit);
  let skipped: string | undefined;
  let done = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const state = entries.get(d)?.state;
    if (state === 'done' && ++done >= target) return d;
    if (state === 'skipped') skipped ??= d;
  }
  return skipped;
}

/**
 * Whether a habit is on the list for `day`: never when archived; a
 * daily one every day; a weekly or monthly one on every day of its
 * period until the day it is done or skipped, that day included (so it
 * shows ticked), and not after. A weekly one of `times` (2026-11-23):
 * every day until the day its target is met or it is skipped, that day
 * included; a day it was done on before then shows done, and it is due
 * again the next.
 */
export function habitDue(
  habit: HabitTarget & Pick<Habit, 'archived'>,
  entries: ReadonlyMap<string, HabitEntry>,
  day: string,
  weekStart: Weekday = 'Mon',
): boolean {
  if (habit.archived) return false;
  if (habit.schedule === 'daily') return true;
  const { start } = habitPeriod(habit.schedule, day, weekStart);
  return (
    start === day || stateBetween(entries, start, addDays(day, -1), habitTimes(habit)) === 'none'
  );
}

/** Whether `day` may be logged on `today`: today, or yesterday after the fact. */
export function canLogHabitDay(day: string, today: string): boolean {
  return day === today || day === addDays(today, -1);
}

/**
 * Whether a habit's `day` can be logged on `today`, as the app offers
 * it (review of #329, 2026-11-21): today; or yesterday after the fact,
 * when the habit was there then (made that day or before: `createdOn`,
 * its `createdAt` in the asker's zone) and yesterday is a period of
 * its own (a daily habit, or the last day of a week or month: within
 * one period, today's tick settles it). Never a day before the habit
 * began. A weekly habit of `times` (2026-11-23) counts each day done,
 * so today's tick does not settle yesterday: its yesterday is loggable
 * within a week too, as a daily habit's.
 */
export function habitDayLoggable(
  habit: HabitTarget,
  day: string,
  today: string,
  options: { weekStart?: Weekday; createdOn?: string } = {},
): boolean {
  if (!canLogHabitDay(day, today)) return false;
  if (options.createdOn !== undefined && day < options.createdOn) return false;
  if (day === today) return true;
  if (habitTimes(habit) > 1) return true;
  const weekStart = options.weekStart ?? 'Mon';
  return (
    habitPeriod(habit.schedule, day, weekStart).start !==
    habitPeriod(habit.schedule, today, weekStart).start
  );
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
 * habit's streak counts weeks, a monthly one's months; a week of a
 * habit of `times` (2026-11-23) counts when that many days are done, and
 * a past week with fewer and no skip ends the streak. `loadedFrom` is
 * the first day the logs given cover (the first of the earliest month
 * read); none means they are all the history there is.
 */
export function habitStreak(
  habit: HabitTarget,
  entries: ReadonlyMap<string, HabitEntry>,
  today: string,
  options: { weekStart?: Weekday; loadedFrom?: string } = {},
): HabitStreak {
  const weekStart = options.weekStart ?? 'Mon';
  const target = habitTimes(habit);
  let period = habitPeriod(habit.schedule, today, weekStart);
  const unread = (p: HabitPeriod) =>
    options.loadedFrom !== undefined && p.start < options.loadedFrom;
  if (unread(period)) return { count: 0, complete: false };
  let count = 0;
  // The current period: counted when done, never against.
  if (stateBetween(entries, period.start, period.end, target) === 'done') count++;
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
    const state = stateBetween(entries, period.start, period.end, target);
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
 * `before`, a day before the habit began. For a weekly habit of
 * `times` (2026-11-23) a week is settled once that many days are done
 * (or one skipped): its other days read `covered` then; a week that ended
 * short of it reads `missed` on its days not done, as one that ended
 * with nothing.
 */
export type HabitDayState = 'done' | 'skipped' | 'covered' | 'missed' | 'open' | 'before';

/**
 * The seven days ending `today`, oldest first, and how each stands.
 * Archived or not alike, as an archived habit's history stays visible.
 * `createdOn` is the day the habit began (its `createdAt` in the
 * asker's zone); days before it are `before`.
 */
export function habitStrip(
  habit: HabitTarget,
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
  habit: HabitTarget,
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
  if (stateBetween(entries, period.start, period.end, habitTimes(habit)) !== 'none') {
    return 'covered';
  }
  // Still loggable (its last day is yesterday): open, not yet missed.
  return period.end < today && !canLogHabitDay(period.end, today) ? 'missed' : 'open';
}

// Nudges (step 4 of #324, 2026-11-21; DESIGN.md, Habits, Nudges): one
// push at the habit's time, only if its period has nothing logged, never
// a second; kept out of the quiet hours. Eric decided the open parts on
// 2026-11-22: a time in quiet hours before midnight is sent as they
// begin ("send at 22:00"); a weekly or monthly habit is nudged on the
// last day of its period ("last day of period"); and the day follows the
// device, through the module's zone (`habitZone`, "follow the device").

/** How late a nudge may still go: past the hourly run that catches a missed wake. */
export const HABIT_NUDGE_LATE_MS = 65 * 60 * 1000;

/** Whether `time` ("HH:MM") falls in the quiet hours `from` to `to`. */
function quiet(time: string, from: string, to: string): boolean {
  if (from === to) return false;
  return from < to ? time >= from && time < to : time >= from || time < to;
}

/** Whether the quiet hours run on past midnight (22:00 to 06:00 do). */
function wraps(config: Pick<HabitsConfig, 'quietFrom' | 'quietTo'>): boolean {
  return config.quietFrom > config.quietTo;
}

const zonesKnown = new Map<string, boolean>();

/** Whether the platform knows IANA zone `tz`. */
function knownZone(tz: string): boolean {
  let known = zonesKnown.get(tz);
  if (known === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      known = true;
    } catch {
      known = false;
    }
    zonesKnown.set(tz, known);
  }
  return known;
}

/**
 * The zone a habit's days and times are read in on the server (Eric,
 * 2026-11-22, "follow the device"): the Habits module's own zone, the
 * zone of the device the app last ran on (`HabitsConfig.tz`, written by
 * the app when it differs), so the server's today is the app's; the
 * habit's own `tz` only while the module has none (or one the platform
 * does not know), as before the decision.
 */
export function habitZone(habit: Pick<Habit, 'tz'>, config: Pick<HabitsConfig, 'tz'>): string {
  return config.tz && knownZone(config.tz) ? config.tz : habit.tz;
}

/**
 * The time of day a nudge for a habit at `time` is sent: its own when
 * outside the quiet hours. Inside them (Eric, 2026-11-22, "send at
 * 22:00"): on their evening side, from their start to midnight when they
 * run on past it, as they begin (22:30 goes at 22:00, that same day); on
 * their morning side, held to their end the same day (03:00 goes at
 * 06:00). Quiet hours that do not run past midnight (12:00 to 14:00)
 * hold every time in them to their end, as before (13:00 at 14:00).
 */
export function habitNudgeTime(time: string, config: HabitsConfig): string {
  const { quietFrom, quietTo } = config;
  if (!quiet(time, quietFrom, quietTo)) return time;
  if (wraps(config) && time >= quietFrom) return quietFrom;
  return quietTo;
}

/** The habit fields a nudge reads. */
export type NudgeHabit = Pick<Habit, 'schedule' | 'time' | 'tz' | 'nudge' | 'archived'> & {
  times?: number;
};

/** The weekday before `weekStart`: the last day of a week starting on it. */
export function lastWeekday(weekStart: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(weekStart) + 6) % 7];
}

/**
 * What a habit's nudge will do (review of #330, 2026-11-22; Eric's
 * decisions of 2026-11-22): the one answer the habit's line, the Edit
 * hint, the assistant's note and the server's sending all read. `at`
 * its own time; `held` to `time`, the end of the quiet hours; `early` at
 * `time`, the start of the quiet hours, its own time being in them
 * before midnight. A daily habit is nudged on its day; a weekly one on
 * the last day of its week (`lastDay`, the weekday before the module's
 * week start); a monthly one on the last day of its month. A weekly one
 * of `times` (2026-11-23, `times` on the plan): on each of the week's
 * last days while the days left, today counted, are no more than the
 * done days still needed (`habitNudgeDue`), so on its last `times` days
 * at most. `off` (the switch off, or archived) and `no-time` send none.
 */
export type HabitNudgePlan =
  | {
      kind: 'at' | 'held' | 'early';
      time: string;
      schedule: Habit['schedule'];
      /** A weekly habit's nudge day: the last of its week. */
      lastDay?: Weekday;
      /** A weekly habit's target, when more than once (2026-11-23). */
      times?: number;
    }
  | { kind: 'no-time' }
  | { kind: 'off' };

export function habitNudgePlan(
  habit: HabitTarget & { time?: string; nudge?: boolean; archived?: boolean },
  config: HabitsConfig,
): HabitNudgePlan {
  if (!habit.nudge || habit.archived) return { kind: 'off' };
  if (habit.time === undefined || habit.time === '') return { kind: 'no-time' };
  const time = habitNudgeTime(habit.time, config);
  const kind = time === habit.time ? 'at' : time === config.quietFrom ? 'early' : 'held';
  const times = habitTimes(habit);
  return {
    kind,
    time,
    schedule: habit.schedule,
    ...(habit.schedule === 'weekly' ? { lastDay: lastWeekday(config.weekStart) } : {}),
    ...(times > 1 ? { times } : {}),
  };
}

/**
 * Whether a plan's moment is the start of quiet hours that run past
 * midnight: the one moment a nudge may go inside them (Eric, 2026-11-22,
 * "send at 22:00"), a habit's own nudge moved earlier to the boundary
 * (or a habit timed at it exactly).
 */
function atQuietStart(time: string, config: HabitsConfig): boolean {
  return wraps(config) && time === config.quietFrom;
}

/** Whether instant `ms`, on the clock in `tz`, is in the quiet hours. */
function quietAt(ms: number, tz: string, config: HabitsConfig): boolean {
  return quiet(zonedTime(ms, tz), config.quietFrom, config.quietTo);
}

/** How many days from `day` to `end`, both counted. */
function daysLeft(day: string, end: string): number {
  let n = 0;
  for (let d = day; d <= end; d = addDays(d, 1)) n++;
  return n;
}

/**
 * The first day on or after `day`, in its period, a habit's nudge can go
 * on: any day for a daily habit; the period's last for a weekly or
 * monthly one; for a weekly one of `times` (2026-11-23), the first of the
 * week's last `times` days, the earliest the days left can be no more
 * than those still needed (which only the check-ins, read in the claim,
 * decide: `habitNudgeDue`).
 */
function nudgeDayFrom(habit: HabitTarget, day: string, weekStart: Weekday): string {
  const { end } = habitPeriod(habit.schedule, day, weekStart);
  const first = addDays(end, 1 - habitTimes(habit));
  return day > first ? day : first;
}

/**
 * The instant a habit's nudge for `day` (YYYY-MM-DD in `habitZone`)
 * goes: its time there, or the start or end of the quiet hours it falls
 * in; none on a day that is not its nudge day (a weekly or monthly
 * habit's is the last of its period), for a habit that does not nudge
 * (off, archived, no time), or when a clock change takes the moment
 * away.
 */
export function habitNudgeAt(
  habit: NudgeHabit,
  day: string,
  config: HabitsConfig,
): number | undefined {
  const plan = habitNudgePlan(habit, config);
  if (plan.kind === 'off' || plan.kind === 'no-time') return undefined;
  if (nudgeDayFrom(habit, day, config.weekStart) !== day) return undefined;
  const tz = habitZone(habit, config);
  try {
    const at = zonedTimeOn(day, plan.time, tz);
    // A time a clock change skips lands just after the gap, still that
    // day; none when that lands it in the quiet hours (a nudge is never
    // sent in them, review of #330), so no wake is queued there either,
    // the start of quiet hours past midnight aside (Eric, 2026-11-22).
    if (zonedDay(at, tz) !== day) return undefined;
    if (quietAt(at, tz, config) && !atQuietStart(plan.time, config)) return undefined;
    return at;
  } catch {
    // A zone the platform does not know: no nudge, never a wrong one.
    return undefined;
  }
}

/** What decides a nudge besides the habit: everything the server reads. */
export interface HabitNudgeContext {
  /** The Habits module is on. */
  on: boolean;
  config: HabitsConfig;
  /**
   * The last day a nudge was sent for this habit, YYYY-MM-DD, if any: a
   * mark in the period stops another in it, but for a weekly habit of
   * `times` (2026-11-23) only one on that day or later, so a second and
   * third nudge can go in a week, never two for one day.
   */
  sentFor?: string;
  /** When the habit was last changed: a nudge is for a moment after it. */
  changedAt?: number;
  /**
   * The check-ins of the nudge's period, by day, once read (the claim
   * reads them; one month log, or two for a week across a month's
   * start); none: not read yet, so not looked at.
   */
  entries?: ReadonlyMap<string, HabitEntry>;
}

/**
 * The nudge due at `now`, if one is: the day (today in `habitZone`) and
 * the moment it was for. Due when the module is on; the habit nudges;
 * today is its nudge day (any day for a daily habit, the last of its
 * week or month otherwise); its moment that day has come no more than
 * HABIT_NUDGE_LATE_MS ago and after the habit last changed (so a time
 * set to one already past brings no push); no nudge was sent for a day
 * of this period or a later one (once per period, whatever the schedule
 * was when it was sent); and the period holds no entry, done or skipped.
 * A weekly habit of `times` (2026-11-23, a rule of the build's, Eric's to
 * overrule): due on a day of its week with no entry, its week not met
 * nor skipped, where the days left, today counted, are no more than the
 * done days still needed; and no nudge sent for today or a later day.
 * With one a week that is exactly the rule above: the last day, nothing
 * logged.
 * Only today is ever looked at, so a nudge late past midnight is never
 * sent. None is sent while `now` is in the quiet hours (review of #330,
 * 2026-11-22), so a 21:30 nudge late past 22:00 is let go, with one
 * exception (Eric, 2026-11-22, "send at 22:00"): a nudge whose moment is
 * the start of quiet hours that run past midnight goes then, or, its
 * wake lost, up to HABIT_NUDGE_LATE_MS later by the hourly run, never
 * past midnight. One held to their end goes as they end, which is not in
 * them.
 */
export function habitNudgeDue(
  habit: NudgeHabit,
  now: number,
  ctx: HabitNudgeContext,
): { day: string; at: number } | undefined {
  if (!ctx.on) return undefined;
  const tz = habitZone(habit, ctx.config);
  let day: string;
  try {
    day = zonedDay(now, tz);
  } catch {
    return undefined;
  }
  const period = habitPeriod(habit.schedule, day, ctx.config.weekStart);
  const target = habitTimes(habit);
  const markedFrom = target > 1 ? day : period.start;
  if (ctx.sentFor !== undefined && ctx.sentFor >= markedFrom) return undefined;
  if (ctx.entries) {
    if (ctx.entries.has(day)) return undefined;
    if (stateBetween(ctx.entries, period.start, period.end, target) !== 'none') return undefined;
    const needed = target - doneBetween(ctx.entries, period.start, period.end);
    if (daysLeft(day, period.end) > needed) return undefined;
  }
  const at = habitNudgeAt(habit, day, ctx.config);
  if (at === undefined || at > now || now - at > HABIT_NUDGE_LATE_MS) return undefined;
  const plan = habitNudgePlan(habit, ctx.config);
  const boundary = 'time' in plan && atQuietStart(plan.time, ctx.config);
  if (quietAt(now, tz, ctx.config) && !boundary) return undefined;
  if (ctx.changedAt !== undefined && at <= ctx.changedAt) return undefined;
  return { day, at };
}

/**
 * The next nudge after `now`, to wake for: this nudge day's if still
 * ahead, else the next's, else the one after (a nudge day can lack one
 * only when a clock change takes its time away); none for a habit that
 * does not nudge. A daily habit's nudge days are every day, a weekly or
 * monthly one's the last day of each period, a weekly one of `times`
 * each of its week's last `times` days (2026-11-23; whether one goes
 * there is the claim's, on the check-ins).
 */
export function habitNextNudge(
  habit: NudgeHabit,
  now: number,
  config: HabitsConfig,
): number | undefined {
  let day: string;
  try {
    day = nudgeDayFrom(habit, zonedDay(now, habitZone(habit, config)), config.weekStart);
  } catch {
    return undefined;
  }
  for (let i = 0; i < 3; i++) {
    const at = habitNudgeAt(habit, day, config);
    if (at !== undefined && at > now) return at;
    day = nudgeDayFrom(habit, addDays(day, 1), config.weekStart);
  }
  return undefined;
}
