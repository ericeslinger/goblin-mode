import {
  type HabitAnswer,
  type HabitDayState,
  type HabitSchedule,
  type HabitsConfig,
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
 * What a habit's row says under its name: a weekly or monthly one's
 * kind, on Right Now the period it is for ("This week"), on the Habits
 * screen how often ("Once a week", the form's own words; step 5 of
 * #324, 2026-11-22); its time of day if it has one ("07:30"), and
 * its nudge (step 4 of #324) by `habitNudgePlan`, as the Edit hint
 * says it (review of #330, 2026-11-22): "Nudge on" only when a push
 * goes at its time, "Nudge at 06:00" when the quiet hours hold it, and
 * nothing when none goes (a weekly or monthly habit, or a time in the
 * quiet hours before midnight); nothing for a daily habit at any time.
 */
export function habitWhen(
  h: { schedule: HabitSchedule; time?: string; nudge?: boolean; archived?: boolean },
  config: HabitsConfig,
  on: 'right-now' | 'screen' = 'right-now',
): string {
  const plan = habitNudgePlan(h, config);
  const kind =
    h.schedule === 'daily'
      ? ''
      : on === 'screen'
        ? SCHEDULE_LABELS[h.schedule]
        : THIS_PERIOD[h.schedule];
  const parts = [
    ...(kind ? [kind] : []),
    ...(h.time ? [h.time] : []),
    ...(plan.kind === 'at' ? ['Nudge on'] : plan.kind === 'held' ? [`Nudge at ${plan.time}`] : []),
  ];
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
 * habit, whose strip and Today row say it all.
 */
export function periodLine(
  h: { schedule: HabitSchedule; state: 'done' | 'skipped' | 'none'; settledOn?: string },
  today: string,
): string {
  if (h.schedule === 'daily') return '';
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
  }
}

/**
 * What the Edit form says under Nudge me (step 4 of #324): that a nudge
 * needs a time; when a daily habit's goes, held through the quiet hours
 * or not sent at all for a time in them before midnight; and that a
 * weekly or monthly habit is not nudged yet. As if switched on, by
 * `habitNudgePlan`, as the habit's line reads it.
 */
export function nudgeHint(schedule: HabitSchedule, time: string, config: HabitsConfig): string {
  const plan = habitNudgePlan({ schedule, time, nudge: true }, config);
  const quiet = `quiet hours (${config.quietFrom} to ${config.quietTo})`;
  switch (plan.kind) {
    case 'off':
    case 'no-time':
      return 'A nudge needs a time of day.';
    case 'not-daily':
      return 'Nudges are for daily habits for now.';
    case 'quiet':
      return `No push: ${time} is in the ${quiet}, which end after its day does.`;
    case 'held':
      return `One push at ${plan.time}, when the ${quiet} end, if not logged by then.`;
    case 'at':
      return `One push at ${time} if not logged by then.`;
  }
}
