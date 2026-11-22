import {
  type HabitDayState,
  type HabitSchedule,
  type HabitsConfig,
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
 * period ("This week"), its time of day if it has one ("07:30"), and
 * its nudge (step 4 of #324) by `habitNudgePlan`, as the Edit hint
 * says it (review of #330, 2026-11-22): "Nudge on" only when a push
 * goes at its time, "Nudge at 06:00" when the quiet hours hold it, and
 * nothing when none goes (a weekly or monthly habit, or a time in the
 * quiet hours before midnight); nothing for a daily habit at any time.
 */
export function habitWhen(
  h: { schedule: HabitSchedule; time?: string; nudge?: boolean; archived?: boolean },
  config: HabitsConfig,
): string {
  const plan = habitNudgePlan(h, config);
  const parts = [
    ...(h.schedule === 'weekly' ? ['This week'] : h.schedule === 'monthly' ? ['This month'] : []),
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
