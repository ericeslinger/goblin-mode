// The listening queue's order (#249, step 3 of #244; Eric 2026-11-10:
// "A listening queue that new episodes append to, but can be
// rearranged"). An episode in the queue carries `queue`, a number, and
// the queue is the episodes that have one, ascending, ties by id. The
// app and the fetcher both place episodes with these, so a new episode
// the server appends lands where one appended by hand would.

/** The gap between neighbours: a second, in the clock's milliseconds. */
export const QUEUE_STEP = 1000;
/** Below this gap a midpoint is not worth writing; the queue is renumbered. */
export const QUEUE_MIN_GAP = 1e-3;
/**
 * The most episodes the queue holds (review on #252, 2026-11-10): the
 * app listens to this many and the assistant reads this many, so
 * neither the app nor the fetcher queues one past it, or it would be
 * queued and never shown.
 */
export const QUEUE_MAX = 500;
/** The rules keep `queue` inside this, so it is always a plain finite number. */
export const QUEUE_BOUND = 1e15;

/**
 * Where an appended episode goes: a step after the last, and never
 * before now (the device's clock, in milliseconds). So two devices
 * appending offline land in the order they appended once both sync,
 * and an empty queue starts at now.
 */
export function orderAfter(last: number | undefined, now: number): number {
  return last === undefined ? now : Math.max(last + QUEUE_STEP, now);
}

/** Where Play next puts an episode: a step before the first; now in an empty queue. */
export function orderBefore(first: number | undefined, now: number): number {
  return first === undefined ? now : first - QUEUE_STEP;
}

/** The order of an episode dropped between two neighbours: their midpoint. */
export function orderBetween(a: number, b: number): number {
  return a + (b - a) / 2;
}

/**
 * Whether two neighbours are too close for a midpoint between them, so
 * the whole queue is renumbered in one batch instead.
 */
export function needsRenumber(a: number, b: number): boolean {
  const mid = orderBetween(a, b);
  return !(b - a >= QUEUE_MIN_GAP) || !(mid > a && mid < b);
}

/** A whole queue's new orders, a step apart from `start`, the first keeping its place. */
export function renumber(count: number, start: number): number[] {
  return Array.from({ length: count }, (_, n) => start + n * QUEUE_STEP);
}

/**
 * The order for an episode put at `index` among the others (their
 * orders, ascending): before the first, after the last, or between two
 * neighbours; undefined when those are too close, so the caller
 * renumbers.
 */
export function orderAt(others: readonly number[], index: number, now: number): number | undefined {
  const at = Math.max(0, Math.min(index, others.length));
  const before = others[at - 1];
  const after = others[at];
  if (before === undefined) return orderBefore(after, now);
  if (after === undefined) return orderAfter(before, now);
  return needsRenumber(before, after) ? undefined : orderBetween(before, after);
}

/** Whether a stored value is a queue order. */
export function isQueueOrder(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < QUEUE_BOUND;
}

/** The queue's order: ascending, ties (two devices' same number) by id, the same everywhere. */
export function byQueue(
  a: { id: string; queue: number },
  b: { id: string; queue: number },
): number {
  return a.queue - b.queue || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
