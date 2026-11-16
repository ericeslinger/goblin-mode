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
  /** Where the day's first row is among the days' rows in order, for the keyboard's cursor. */
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
 * The list cut into days: each day once, in the order its first row
 * comes, its rows in the list's order. The list is newest first, so
 * this is the list's own order; a row out of order joins its day
 * rather than starting a second one, so a day's key names it alone
 * and a page can keep its section while rows above it change. `start`
 * counts the rows of the days before, so the day's rows are
 * `start` to `start + items.length - 1` of the days read in order.
 */
export function groupByDay<T extends { id: string; published: number; read: boolean }>(
  items: readonly T[],
  now: number,
  tz: string,
): Day<T>[] {
  const today = zonedDay(now, tz);
  const byKey = new Map<string, Day<T>>();
  for (const item of items) {
    const key = dayKey(item.published, today, tz);
    let day = byKey.get(key);
    if (!day) {
      day = { key, label: dayLabel(key, today), items: [], unread: [], start: 0 };
      byKey.set(key, day);
    }
    day.items.push(item);
    if (!item.read) day.unread.push(item.id);
  }
  const days = [...byKey.values()];
  let start = 0;
  for (const day of days) {
    day.start = start;
    start += day.items.length;
  }
  return days;
}
