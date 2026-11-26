import {
  type HabitAnswer,
  type HabitDayState,
  type HabitNudgePlan,
  type HabitSchedule,
  type HabitsConfig,
  type Weekday,
  WEEKDAYS,
  addDays,
  habitNudgePlan,
} from '@mossgoblin/schema';

// The words and marks the Habits screen and Right Now put on a habit
// (#324, step 2): pure, so the specs can read them.

/** The period a schedule counts in, one and many. */
const UNIT: Record<HabitSchedule, [string, string]> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
};

/**
 * How often, as the add form and Edit offer it and the Habits screen
 * names it (step 5 of #324, 2026-11-22), in that order.
 */
export const SCHEDULE_LABELS: Record<HabitSchedule, string> = {
  daily: 'Every day',
  weekly: 'Once a week',
  monthly: 'Once a month',
};

/**
 * How often in words, a weekly habit's days a week with it (2026-11-23):
 * "Once a week", "Twice a week", "3 times a week"; or its own day of the
 * week (2026-11-25), "Every Wednesday".
 */
export function scheduleLabel(schedule: HabitSchedule, times?: number, weekday?: Weekday): string {
  if (schedule !== 'weekly') return SCHEDULE_LABELS[schedule];
  if (times !== undefined && times >= 2) {
    return times === 2 ? 'Twice a week' : `${times} times a week`;
  }
  if (weekday !== undefined) return `Every ${WEEKDAY_NAMES[weekday]}`;
  return SCHEDULE_LABELS[schedule];
}

/** A weekday's whole name: "Sunday". */
const WEEKDAY_NAMES: Record<Weekday, string> = {
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
  Sun: 'Sunday',
};

/**
 * Which day of the week, as the add form and Edit offer it for a weekly
 * habit (2026-11-25): Any day unless chosen, which stores nothing, then
 * Monday to Sunday.
 */
export const WEEKDAY_CHOICES: readonly { value: Weekday | ''; label: string }[] = [
  { value: '', label: 'Any day' },
  ...WEEKDAYS.map((value) => ({ value, label: WEEKDAY_NAMES[value] })),
];

/**
 * How many times a week, as the add form and Edit offer it for a weekly
 * habit (2026-11-23): 1 to 7, once unless chosen; once stores nothing.
 */
export const TIMES_CHOICES = [1, 2, 3, 4, 5, 6, 7].map((value) => ({
  value,
  label: value === 1 ? 'Once' : value === 2 ? 'Twice' : `${value} times`,
}));

/**
 * A weekly habit's week so far (2026-11-23), for one of several days a
 * week: "1 of 3 this week"; none for a habit of one a period.
 */
export function weekCount(count: { done: number; target: number } | undefined): string {
  if (!count || count.target < 2) return '';
  return `${Math.min(count.done, count.target)} of ${count.target} this week`;
}

/** The choices of how often, in the order the forms offer them. */
export const SCHEDULE_CHOICES = (['daily', 'weekly', 'monthly'] as const).map((value) => ({
  value,
  label: SCHEDULE_LABELS[value],
}));

/**
 * What a habit is answered with, as the add form and Edit offer it (step
 * 6 of #324, 2026-11-22), in that order: Just done unless chosen.
 */
export const ANSWER_CHOICES: readonly { value: HabitAnswer; label: string }[] = [
  { value: 'done', label: 'Just done' },
  { value: 'choice', label: 'One of a list' },
  { value: 'text', label: 'A line of text' },
  { value: 'note', label: 'A note' },
];

/** A day's answer as a strip's words and a row show it (step 6 of #324). */
export type ShownAnswer = { text: string; held?: true } | { sealed: true } | { noteId: string };

/**
 * A day's answer in words, after its state ("done, calm"): its text;
 * "answer sealed" for one this device cannot open; "with a note" for a
 * note habit's entry; nothing for none or an empty text.
 */
export function answerWords(answer: ShownAnswer | undefined): string {
  if (!answer) return '';
  if ('sealed' in answer) return 'answer sealed';
  if ('noteId' in answer) return 'with a note';
  return answer.text;
}

/**
 * A choice habit's last seven days' answers at a glance, newest first
 * (step 6 of #324): "Lately: today calm · yesterday tired · Thu calm".
 * Only days with an answer; none at all, nothing. A sealed one is said
 * as sealed, never left out without a word.
 */
export function latelyLine(
  strip: readonly { day: string; answer?: ShownAnswer }[],
  today: string,
): string {
  const parts = [...strip].reverse().flatMap((d) => {
    const words = d.answer && !('noteId' in d.answer) ? answerWords(d.answer) : '';
    if (!words) return [];
    const when =
      d.day === today
        ? 'today'
        : d.day === addDays(today, -1)
          ? 'yesterday'
          : dayName(d.day).slice(0, 3);
    return [`${when} ${words}`];
  });
  return parts.length ? `Lately: ${parts.join(' · ')}` : '';
}

/** The period a weekly or monthly habit is for now, as Right Now marks it. */
const THIS_PERIOD: Record<HabitSchedule, string> = {
  daily: '',
  weekly: 'This week',
  monthly: 'This month',
};

/**
 * "Streak: 5 days", "Streak: 1 week"; none yet says so. One still
 * running where the months read begin (`complete` false, a further month
 * not read yet) is "Streak: at least 30 days" (review of #328,
 * 2026-11-21).
 */
export function streakLine(schedule: HabitSchedule, count: number, complete = true): string {
  if (count <= 0) return 'No streak yet';
  const [one, many] = UNIT[schedule];
  return `Streak: ${complete ? '' : 'at least '}${count} ${count === 1 ? one : many}`;
}

/**
 * A nudge's words on a habit's line (step 4 of #324; Eric's decisions
 * of 2026-11-22): a daily habit's "Nudge on" at its own time, "Nudge at
 * 06:00" (or "at 22:00") where the quiet hours move it; a weekly one's
 * on the last day of its week, "Nudge on Sunday", "Nudge Sunday at
 * 22:00"; a monthly one's on the last day of its month, "Nudge on the
 * last day", "Nudge on the last day at 06:00". None when none goes.
 */
function nudgeWords(plan: HabitNudgePlan): string {
  if (plan.kind === 'off' || plan.kind === 'no-time') return '';
  const moved = plan.kind !== 'at';
  // Its own weekday (2026-11-25): that day, which its line names already.
  if (plan.weekday !== undefined) return moved ? `Nudge at ${plan.time}` : 'Nudge on';
  // Several days a week (2026-11-23): on the late days still needed.
  if (plan.times !== undefined)
    return moved ? `Nudge late in the week at ${plan.time}` : 'Nudge late in the week';
  if (plan.schedule === 'weekly') {
    const day = WEEKDAY_NAMES[plan.lastDay ?? 'Sun'];
    return moved ? `Nudge ${day} at ${plan.time}` : `Nudge on ${day}`;
  }
  if (plan.schedule === 'monthly')
    return moved ? `Nudge on the last day at ${plan.time}` : 'Nudge on the last day';
  return moved ? `Nudge at ${plan.time}` : 'Nudge on';
}

/**
 * What a habit's row says under its name: a weekly or monthly one's
 * kind, on Right Now the period it is for ("This week"), on the Habits
 * screen how often ("Once a week", the form's own words; step 5 of
 * #324, 2026-11-22); its time of day if it has one ("07:30"), and
 * its nudge (step 4 of #324) by `habitNudgePlan`, as the Edit hint
 * says it (review of #330, 2026-11-22; `nudgeWords`): "Nudge on" only
 * when a push goes at its time on its day, "Nudge at 06:00" when the
 * quiet hours move it, a weekly or monthly one's naming its day
 * (Eric's decisions of 2026-11-22), and nothing when none goes. A
 * weekly one with its own weekday (2026-11-25) says it in both places,
 * "Every Wednesday", and its nudge as a daily one's, on that day.
 */
export function habitWhen(
  h: {
    schedule: HabitSchedule;
    times?: number;
    weekday?: Weekday;
    time?: string;
    nudge?: boolean;
    archived?: boolean;
    count?: { done: number; target: number };
  },
  config: HabitsConfig,
  on: 'right-now' | 'screen' = 'right-now',
): string {
  const nudge = nudgeWords(habitNudgePlan(h, config));
  // Several days a week (2026-11-23): on Right Now its week so far, "1 of
  // 3 this week", where a weekly one says "This week"; on the screen how
  // often, "3 times a week", its count on the period line below.
  const kind =
    h.schedule === 'daily'
      ? ''
      : on === 'screen' || (h.schedule === 'weekly' && h.weekday !== undefined && !h.times)
        ? scheduleLabel(h.schedule, h.times, h.weekday)
        : weekCount(h.count) || THIS_PERIOD[h.schedule];
  const parts = [...(kind ? [kind] : []), ...(h.time ? [h.time] : []), ...(nudge ? [nudge] : [])];
  return parts.join(' · ');
}

/** A day of the strip as words: "Mon 16 Nov". */
export function dayName(day: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${day}T12:00:00Z`));
}

/** "1st", "2nd", "3rd", "11th", "22nd": a day of the month. */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/**
 * How a weekly or monthly habit's period stands, as a plain line on the
 * Habits screen (step 5 of #324, 2026-11-22): "Not done yet this week",
 * "Done this week, today", "Done this week, on Monday", "Skipped this
 * month, on the 3rd". A seven-day strip shows most of a week but little
 * of a month, so the line says the period whole. None for a daily
 * habit, whose strip and Today row say it all. A weekly one with its own
 * weekday (2026-11-25): "Due today" on its day with nothing logged; on
 * any other day when it is next due, "Next due tomorrow", "Next due on
 * Wed 2 Dec", after how its week stands once settled ("Done this week,
 * yesterday · Next due on Wed 2 Dec").
 */
export function periodLine(
  h: {
    schedule: HabitSchedule;
    state: 'done' | 'skipped' | 'none';
    settledOn?: string;
    count?: { done: number; target: number };
    nextDue?: string;
  },
  today: string,
): string {
  if (h.schedule === 'daily') return '';
  if (h.nextDue !== undefined) {
    const next =
      h.nextDue === today
        ? ''
        : h.nextDue === addDays(today, 1)
          ? 'Next due tomorrow'
          : `Next due on ${dayName(h.nextDue)}`;
    if (h.state === 'none') return next || 'Due today';
    return [settledLine({ ...h, count: undefined }, today), next].filter(Boolean).join(' · ');
  }
  return settledLine(h, today);
}

/** How a weekly or monthly habit's period stands, its days counted or settled. */
function settledLine(
  h: {
    schedule: HabitSchedule;
    state: 'done' | 'skipped' | 'none';
    settledOn?: string;
    count?: { done: number; target: number };
  },
  today: string,
): string {
  // Several days a week (2026-11-23): its count, met or not, unless the
  // week was skipped, which the line says as for any weekly habit.
  const count = weekCount(h.count);
  if (count && h.state !== 'skipped') return count;
  const period = h.schedule === 'weekly' ? 'this week' : 'this month';
  if (h.state === 'none' || h.settledOn === undefined) return `Not done yet ${period}`;
  const day = h.settledOn;
  const when =
    day === today
      ? 'today'
      : day === addDays(today, -1)
        ? 'yesterday'
        : h.schedule === 'weekly'
          ? `on ${weekday(day)}`
          : `on the ${ordinal(Number(day.slice(8, 10)))}`;
  return `${h.state === 'done' ? 'Done' : 'Skipped'} ${period}, ${when}`;
}

/** A day's weekday, whole: "Monday". */
function weekday(day: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

/** The weekday's first letter, over a day of the strip. */
export function dayInitial(day: string): string {
  return dayName(day).charAt(0);
}

/**
 * Each state of a strip's day: its mark, drawn alongside its words
 * (never colour alone), and the words a screen reader and a mouse's
 * title give it.
 */
export function dayState(
  state: HabitDayState,
  schedule: HabitSchedule,
): { mark: string; words: string } {
  const period = schedule === 'monthly' ? 'month' : 'week';
  switch (state) {
    case 'done':
      return { mark: '✓', words: 'done' };
    case 'skipped':
      return { mark: '–', words: 'skipped' };
    case 'covered':
      return { mark: '·', words: `settled that ${period}` };
    case 'missed':
      return { mark: '×', words: 'missed' };
    case 'open':
      return { mark: '', words: 'not logged yet' };
    case 'before':
      return { mark: '', words: 'before the habit began' };
    case 'off':
      return { mark: '', words: 'not its day' };
  }
}

/**
 * What the Edit form says under Nudge me (step 4 of #324): that a nudge
 * needs a time; else when it goes, as if switched on, by
 * `habitNudgePlan`, as the habit's line reads it. Eric's decisions of
 * 2026-11-22: a time in the quiet hours before midnight goes as they
 * begin, one after it as they end; a weekly habit is nudged on the last
 * day of its week ("One push on Sunday at 21:00 if not done this
 * week."), a monthly one on the last day of its month; one with its own
 * weekday on that day (2026-11-25, "One push on Wednesday at 19:00 if not
 * done that day.").
 */
export function nudgeHint(
  schedule: HabitSchedule,
  time: string,
  config: HabitsConfig,
  times?: number,
  weekday?: Weekday,
): string {
  const plan = habitNudgePlan({ schedule, time, nudge: true, times, weekday }, config);
  if (plan.kind === 'off' || plan.kind === 'no-time') return 'A nudge needs a time of day.';
  const quiet = `quiet hours (${config.quietFrom} to ${config.quietTo})`;
  const why =
    plan.kind === 'held'
      ? `, when the ${quiet} end,`
      : plan.kind === 'early'
        ? `, as the ${quiet} begin,`
        : '';
  if (plan.weekday !== undefined)
    return `One push on ${WEEKDAY_NAMES[plan.weekday]} at ${plan.time}${why} if not done that day.`;
  // Several days a week (2026-11-23): one a day at most, late in the week.
  if (plan.times !== undefined)
    return (
      `One push at ${plan.time}${why} on a day not logged yet, once the days left in the ` +
      `week are no more than those still needed: the last ${plan.times} days if none is done.`
    );
  if (plan.schedule === 'weekly')
    return `One push on ${WEEKDAY_NAMES[plan.lastDay ?? 'Sun']} at ${plan.time}${why} if not done this week.`;
  if (plan.schedule === 'monthly')
    return `One push on the last day of the month at ${plan.time}${why} if not done this month.`;
  return `One push at ${plan.time}${why} if not logged by then.`;
}
