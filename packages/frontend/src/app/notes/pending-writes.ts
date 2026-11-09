/**
 * Keep until acknowledged (#198, #200; DESIGN.md, Client, Saving): a
 * write through the persistent cache is taken in a moment later
 * (IndexedDB), and a page closed or reloaded in that moment loses it. So
 * the words are kept on the device at once, beside what the field held
 * when they were typed, and forgotten once the server has them. After a
 * load, once the first snapshot from the server arrives (kept across
 * loads until then), they are written again only while the field still
 * holds that prior value: holding the words, the cache kept them;
 * holding anything else, someone wrote the field since, and theirs is
 * newer.
 */
export interface PendingWrite {
  /** Whose notes: an entry is never replayed into another account's. */
  uid: string;
  /** The words, not yet acknowledged. */
  value: string;
  /** What the field held before them; null for no field or no note. */
  base: string | null;
  /**
   * Words this device wrote before `value` that the cache was not yet
   * showing when `value` was written: one of them may be what the cache
   * kept, so the field holding one still means `value` was lost.
   */
  earlier?: string[];
}

export type PendingWrites = Record<string, PendingWrite>;

/** How many earlier words an entry remembers; the cache takes a write in milliseconds. */
const EARLIER_KEPT = 5;

/**
 * The entry for writing `value` over `shown`, what the cache shows in the
 * field now (null for nothing). A snapshot carries a write only once the
 * cache holds it (the SDK raises it after the local IndexedDB commit),
 * so what it shows is the floor a reload comes back to; while it still
 * shows the entry's base or earlier words, the entry's own words are in
 * flight and join `earlier`.
 */
export function nextPending(
  prev: PendingWrite | undefined,
  uid: string,
  value: string,
  shown: string | null,
): PendingWrite {
  if (prev?.uid === uid && prev.value === value) return prev;
  const inFlight =
    prev?.uid === uid &&
    shown !== prev.value &&
    (shown === prev.base || (shown !== null && !!prev.earlier?.includes(shown)));
  if (!prev || !inFlight) return { uid, value, base: shown };
  const earlier = [...(prev.earlier ?? []), prev.value].slice(-EARLIER_KEPT);
  return { uid, value, base: prev.base, earlier };
}

/**
 * Whether a field holding `now` lost `entry`'s words. `now` must come
 * from the server, not the persisted cache, which can be stale (review
 * on #204). A field written over and then back to `base` (ABA) cannot
 * be told apart from one never written over by this check, and is
 * accepted: the words come back over it.
 */
export function lost(entry: PendingWrite, now: string | null): boolean {
  if (now === entry.value) return false;
  return now === entry.base || (now !== null && !!entry.earlier?.includes(now));
}

/** A stored entry is used only in its current shape. */
export function isPendingWrite(value: unknown): value is PendingWrite {
  const v = value as PendingWrite | undefined;
  return (
    typeof v?.uid === 'string' &&
    typeof v.value === 'string' &&
    (v.base === null || typeof v.base === 'string')
  );
}
