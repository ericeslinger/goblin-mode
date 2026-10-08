// Waking sendDue when a push is due, instead of polling every minute
// (Eric, 2026-10-07: sendDuePush ran 1,440 times a day). A reminder's
// write queues a Cloud Task for its `nextFireAt`; the task runs sendDue,
// whose claim already makes any run safe. Over a small queue interface,
// so it runs in unit specs without Cloud Tasks (cloud-tasks.ts is the
// real one).

/** Cloud Tasks schedules at most 30 days ahead; a later push hops. */
export const MAX_AHEAD_MS = 29 * 24 * 60 * 60 * 1000;

export interface WakeQueue {
  /**
   * Queues a wake for reminder `id` at `at` (ms), named `name`. A name
   * already queued is a duplicate and is dropped without error.
   */
  enqueue(uid: string, id: string, at: number, name: string): Promise<void>;
}

/** How far ahead the hourly run queues wakes: past the next run. */
export const UPCOMING_MS = 65 * 60 * 1000;

/** A reminder's next push, as the hourly run finds it. */
export interface Upcoming {
  uid: string;
  id: string;
  nextFireAt: number;
}

/**
 * Queues a wake for each push due before the next hourly run, so one a
 * task missed (or set before tasks existed) still goes on time. Names
 * match `wakeFor`'s, so one already queued is not queued twice.
 */
export async function wakeUpcoming(
  queue: WakeQueue,
  upcoming: readonly Upcoming[],
  now: number,
): Promise<number> {
  for (const r of upcoming) await wakeFor(queue, r.uid, r.id, undefined, r.nextFireAt, now);
  return upcoming.length;
}

/**
 * When to wake for a push at `fireAt`: then, or, beyond a task's reach,
 * the nearest hop on a grid counted back from `fireAt` in steps of
 * `MAX_AHEAD_MS`, so every caller names the same hop alike.
 */
export function wakeAt(fireAt: number, now: number): number {
  if (fireAt <= now) return now;
  const hops = Math.max(0, Math.ceil((fireAt - now - MAX_AHEAD_MS) / MAX_AHEAD_MS));
  return fireAt - hops * MAX_AHEAD_MS;
}

/** A task name per reminder, push time and wake time: the same write twice queues once. */
export function wakeName(uid: string, id: string, fireAt: number, at: number): string {
  return `${uid}-${id}-${fireAt}-${at}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Queues a wake for a reminder whose push time is new: set, or moved
 * (snoozed, edited, or advanced by a claim). Nothing when it was removed
 * or did not change.
 */
export async function wakeFor(
  queue: WakeQueue,
  uid: string,
  id: string,
  before: number | undefined,
  after: number | undefined,
  now: number,
): Promise<boolean> {
  if (after === undefined || after === before) return false;
  const at = wakeAt(after, now);
  await queue.enqueue(uid, id, at, wakeName(uid, id, after, at));
  return true;
}
