// The assistant's Habits tools (#324 step 3, 2026-11-21; DESIGN.md,
// Habits): the pure parts, apart from Firestore. Reading a month log
// leniently, finding a habit by id or name, and reading back as many
// months as a streak needs, up to a cap. The rules of what is due, a
// period's state and the streak are the shared ones in
// `packages/schema/src/habits.ts`; nothing here decides them again.
import {
  HABIT_DAY_KEYS,
  type Habit,
  HabitEntry,
  type Weekday,
  addDays,
  habitEntries,
  habitMonth,
  habitStreak,
  normalizeName,
  zonedDay,
} from '@mossgoblin/schema';
import { ToolError } from './tool-error';

/**
 * The most months a streak is read back over, counting the ones the
 * day's list needs: two years. A streak still running there is given
 * as counted so far, and said to be capped.
 */
export const HABIT_STREAK_MONTHS = 24;
/** How many months one read back fetches at once. */
const STREAK_CHUNK = 6;

/** One month log as read: its month, and the days that parsed. */
export interface HabitMonthRead {
  month: string;
  days: Record<string, HabitEntry>;
}

/**
 * The entries of a stored log, by day key, read entry by entry, as the
 * app reads them (HabitsService, `readDays`): a day of the month that
 * parses as a `HabitEntry` is kept; a day the month lacks, or an entry
 * that does not parse, is dropped, never the month with it.
 */
export function readHabitDays(data: unknown, month: string): Record<string, HabitEntry> {
  const days = (data as { days?: unknown } | undefined)?.days;
  const out: Record<string, HabitEntry> = {};
  if (!days || typeof days !== 'object') return out;
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (const [key, entry] of Object.entries(days as Record<string, unknown>)) {
    if (!HABIT_DAY_KEYS.includes(key) || Number(key) > last) continue;
    const parsed = HabitEntry.safeParse(entry);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/** The month before `month` (YYYY-MM). */
export function previousMonth(month: string): string {
  return habitMonth(addDays(`${month}-01`, -1));
}

/** Today in `tz`, or undefined when the zone is not one the platform knows. */
export function habitToday(now: number, tz: string): string | undefined {
  try {
    return zonedDay(now, tz);
  } catch {
    return undefined;
  }
}

/** How a day stands on its own: done, skipped, or nothing logged. */
export function dayState(
  entries: ReadonlyMap<string, HabitEntry>,
  day: string,
): 'done' | 'skipped' | 'none' {
  return entries.get(day)?.state ?? 'none';
}

/** What a streak counts, by the schedule. */
export function streakUnit(schedule: Habit['schedule']): 'days' | 'weeks' | 'months' {
  return schedule === 'daily' ? 'days' : schedule === 'weekly' ? 'weeks' : 'months';
}

/** The key a habit's name is matched by: case and spacing aside. */
export const habitNameKey = (name: string) => normalizeName(name);

/**
 * The habit `ref` names among `habits`: its id, else its name (exact,
 * case and spacing aside), an unarchived one before an archived one.
 * Refused when nothing matches, or when the name is not one habit's.
 */
export function findHabit<T extends { id: string; habit: Pick<Habit, 'name' | 'archived'> }>(
  habits: readonly T[],
  ref: string,
): T {
  const byId = habits.find((h) => h.id === ref);
  if (byId) return byId;
  const key = habitNameKey(ref);
  const named = habits.filter((h) => habitNameKey(h.habit.name) === key);
  const live = named.filter((h) => !h.habit.archived);
  const pick = live.length ? live : named;
  if (pick.length === 1) return pick[0];
  if (pick.length > 1) {
    throw new ToolError(
      `${pick.length} habits are named ${ref}; give one's id (list_habits gives them)`,
    );
  }
  throw new ToolError(`no habit ${ref}; list_habits names them`);
}

/**
 * The streak as of `today`, reading back month by month while it is
 * still running at the earliest month read (`complete: false` from
 * `habitStreak`), never before the month the habit began, and at most
 * HABIT_STREAK_MONTHS months in all. `read` holds the months already
 * read, oldest first (a month with no log as no days); `readMore` reads
 * the months asked for, in the order asked.
 */
export async function streakReadBack(
  habit: Pick<Habit, 'schedule'>,
  today: string,
  options: {
    weekStart: Weekday;
    /** The day the habit began, in its zone. */
    createdOn?: string;
    read: readonly HabitMonthRead[];
    readMore: (months: string[]) => Promise<HabitMonthRead[]>;
    cap?: number;
  },
): Promise<{ count: number; capped: boolean }> {
  const cap = options.cap ?? HABIT_STREAK_MONTHS;
  let read = [...options.read];
  const began = options.createdOn ? habitMonth(options.createdOn) : undefined;
  for (;;) {
    const first = read[0]?.month ?? habitMonth(today);
    // From the month it began, the logs read are all there is.
    const all = began !== undefined && began >= first;
    const streak = habitStreak(habit, habitEntries(read), today, {
      weekStart: options.weekStart,
      ...(all ? {} : { loadedFrom: `${first}-01` }),
    });
    if (streak.complete) return { count: streak.count, capped: false };
    if (read.length >= cap) return { count: streak.count, capped: true };
    const more: string[] = [];
    for (let m = first; more.length < Math.min(STREAK_CHUNK, cap - read.length);) {
      m = previousMonth(m);
      if (began !== undefined && m < began) break;
      more.unshift(m);
    }
    if (!more.length) return { count: streak.count, capped: false };
    read = [...(await options.readMore(more)), ...read];
  }
}
