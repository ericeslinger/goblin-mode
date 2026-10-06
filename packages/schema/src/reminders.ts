// Pure reminder logic shared by the app and (later) sendDuePush: when a
// reminder is due, which Right Now section it sits in, and what done and
// snooze change. Times are epoch milliseconds; callers convert to and
// from Firestore Timestamps.
import type { Recurrence, ReminderStatus } from './model';

/** The fields that done, snooze and undo change. */
export interface ReminderTimes {
  status: ReminderStatus;
  dueAt?: number;
  snoozedUntil?: number;
  nextFireAt?: number;
}

export type Section = 'overdue' | 'today' | 'soon' | 'someday';

export const SECTIONS: readonly { id: Section; label: string }[] = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'soon', label: 'Soon' },
  { id: 'someday', label: 'Someday' },
];

/** When a reminder next wants attention: its snooze, else its due time. */
export function effectiveDue(r: {
  status: ReminderStatus;
  dueAt?: number;
  snoozedUntil?: number;
}): number | undefined {
  return r.status === 'snoozed' && r.snoozedUntil !== undefined ? r.snoozedUntil : r.dueAt;
}

/** Overdue, today (same calendar day in `tz`), soon, or no time at all. */
export function sectionOf(due: number | undefined, now: number, tz: string): Section {
  if (due === undefined) return 'someday';
  if (due < now) return 'overdue';
  return sameDay(due, now, tz) ? 'today' : 'soon';
}

/**
 * Marks a reminder done. A one-off is finished; a recurring one stays
 * open and moves to its next occurrence after both now and its current
 * due time, so finishing early does not repeat the same day.
 */
export function markDone(
  r: ReminderTimes & { recurrence?: Recurrence },
  now: number,
): ReminderTimes {
  if (!r.recurrence) return { status: 'done' };
  const from = r.dueAt ?? now;
  const next = nextOccurrence(r.recurrence, from, Math.max(now, from));
  return { status: 'open', dueAt: next, nextFireAt: next };
}

/** Hides a reminder until `until`, when it is due (and pushed) again. */
export function snoozeUntil(r: ReminderTimes, until: number): ReminderTimes {
  return { status: 'snoozed', dueAt: r.dueAt, snoozedUntil: until, nextFireAt: until };
}

/**
 * When to push next, once a push has gone out at `now`: the next
 * occurrence of a repeat (the first one after now, counting today's if
 * it is still ahead, on the weekday of `dueAt` for weekly), or nothing
 * for a one-off. `dueAt` is left alone, so an ignored reminder stays
 * Overdue while a repeat keeps nudging.
 */
export function nextPushAfter(
  r: ReminderTimes & { recurrence?: Recurrence },
  now: number,
): number | undefined {
  if (!r.recurrence || r.status === 'done') return undefined;
  const anchor = r.dueAt ?? now;
  const day = 24 * 60 * 60 * 1000;
  // Step from one period before the anchor, so the anchor's own day counts.
  return nextOccurrence(r.recurrence, anchor - (r.recurrence.freq === 'weekly' ? 7 : 1) * day, now);
}

/** The quick snooze choices at `now`; "Tonight" only before 7 pm. */
export function snoozeChoices(now: number, tz: string): { label: string; at: number }[] {
  const today = wallDate(now, tz);
  const choices = [{ label: 'In an hour', at: now + 60 * 60 * 1000 }];
  const tonight = atWallTime(today, '20:00', tz);
  if (tonight - now >= 60 * 60 * 1000) choices.push({ label: 'Tonight', at: tonight });
  choices.push({ label: 'Tomorrow', at: atWallTime(addDays(today, 1), '09:00', tz) });
  return choices;
}

/** The first occurrence of a new recurring reminder after `now`. */
export function firstOccurrence(rec: Recurrence, now: number): number {
  const today = wallDate(now, rec.tz);
  const t = atWallTime(today, rec.time, rec.tz);
  if (t > now && allowed(rec, today)) return t;
  return nextOccurrence(rec, t, now);
}

/**
 * The first occurrence after `after`, stepping from the calendar day of
 * `from` in the recurrence's time zone. A weekly reminder keeps the
 * weekday of `from`.
 */
export function nextOccurrence(rec: Recurrence, from: number, after: number): number {
  let day = wallDate(from, rec.tz);
  // Bounded: ten years of days is far more than any real gap.
  for (let i = 0; i < 3660; i++) {
    day = addDays(day, rec.freq === 'weekly' ? 7 : 1);
    if (!allowed(rec, day)) continue;
    const t = atWallTime(day, rec.time, rec.tz);
    if (t > after) return t;
  }
  throw new Error('no next occurrence');
}

/** A calendar day; `weekday` is 0 for Sunday. */
interface WallDate {
  y: number;
  m: number;
  d: number;
  weekday: number;
}

function allowed(rec: Recurrence, day: WallDate): boolean {
  return rec.freq !== 'weekdays' || (day.weekday !== 0 && day.weekday !== 6);
}

/** Whether two instants fall on the same calendar day in `tz`. */
export function sameDay(a: number, b: number, tz: string): boolean {
  const x = wallDate(a, tz);
  const y = wallDate(b, tz);
  return x.y === y.y && x.m === y.m && x.d === y.d;
}

function addDays(day: WallDate, n: number): WallDate {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    weekday: t.getUTCDay(),
  };
}

const formats = new Map<string, Intl.DateTimeFormat>();

function parts(ms: number, tz: string): Record<string, number> {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(ms)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

function wallDate(ms: number, tz: string): WallDate {
  const p = parts(ms, tz);
  return addDays({ y: p['year']!, m: p['month']!, d: p['day']!, weekday: 0 }, 0);
}

/** How far `tz` is ahead of UTC at instant `ms`. */
function offset(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(
    p['year']!,
    p['month']! - 1,
    p['day']!,
    p['hour']!,
    p['minute']!,
    p['second']!,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in `tz`. A time repeated by a
 * clock change takes the first; one skipped lands just after the gap.
 */
function atWallTime(day: WallDate, time: string, tz: string): number {
  const [h, min] = time.split(':').map(Number);
  const guess = Date.UTC(day.y, day.m - 1, day.d, h, min);
  const half = 12 * 60 * 60 * 1000;
  const before = guess - offset(guess - half, tz);
  const after = guess - offset(guess + half, tz);
  const matches = [before, after].filter((t) => {
    const p = parts(t, tz);
    return p['hour'] === h && p['minute'] === min;
  });
  return matches.length ? Math.min(...matches) : before;
}
