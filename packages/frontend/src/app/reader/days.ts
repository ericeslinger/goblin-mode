import { addDays, zonedDay } from '@mossgoblin/schema';

// The Reader's list by day (#288, 2026-11-15): the rows as the list
// already has them, newest first by `published`, cut where the day
// changes in the gardener's own time zone, each day under a heading
// with what is unread in it.

/** The key of the day an article has no date for (the fetcher stores 0). */
export const NO_DATE = 'none';

/** One day of a list: its rows in the list's order, and the unread among them. */
export interface Day<T> {
  /** YYYY-MM-DD in the time zone, or NO_DATE. */
  key: string;
  /** "Today", "Yesterday", "Thursday, Nov 12", or "No date". */
  label: string;
  items: T[];
  /** The ids of the unread rows: what the day's Mark these read marks. */
  unread: string[];
  /** Where the day's first row is in the whole list, for the keyboard's cursor. */
  start: number;
}

/**
 * The day an article falls on: its published time's calendar day in
 * `tz`, or NO_DATE without one. A feed whose clock runs ahead (a post
 * stamped later than now) counts as today, not as a day to come.
 */
export function dayKey(published: number, today: string, tz: string): string {
  if (!Number.isFinite(published) || published <= 0) return NO_DATE;
  const key = zonedDay(published, tz);
  return key > today ? today : key;
}

/**
 * A day's heading: Today, Yesterday, else the weekday and date, with
 * the year when it is not this year's. In English, as the rest of the
 * app's words are.
 */
export function dayLabel(key: string, today: string): string {
  if (key === NO_DATE) return 'No date';
  if (key === today) return 'Today';
  if (key === addDays(today, -1)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  // Noon UTC of that calendar date, read in UTC: the date as written.
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
  });
}

/**
 * The list cut into days, in its own order: a run of rows on one day
 * is one day, so the rows are drawn exactly as the list has them and
 * the keyboard's cursor (an index into the list) still names the row
 * it did. The list is newest first, so each day comes once; one out
 * of order would start a second run of its day rather than move.
 */
export function groupByDay<T extends { id: string; published: number; read: boolean }>(
  items: readonly T[],
  now: number,
  tz: string,
): Day<T>[] {
  const today = zonedDay(now, tz);
  const days: Day<T>[] = [];
  let last: Day<T> | undefined;
  items.forEach((item, n) => {
    const key = dayKey(item.published, today, tz);
    if (!last || last.key !== key) {
      last = { key, label: dayLabel(key, today), items: [], unread: [], start: n };
      days.push(last);
    }
    last.items.push(item);
    if (!item.read) last.unread.push(item.id);
  });
  return days;
}
