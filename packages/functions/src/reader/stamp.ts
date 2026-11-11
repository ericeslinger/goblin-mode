// The module stamp (#248; Eric, 2026-11-11: a module owns its records,
// and no other module's query reads them). Reader articles and Podcasts
// episodes share `feedItems`; `podcast` on each item says which module
// owns it, from its feed's `kind`, so each module's queries filter on
// it. The fetcher and the Feedly import stamp what they write; this
// file holds the rest, pure over a store: a feed's items restamped
// when it moves (or goes), and the backfill of the items stored before
// the stamp, which ends in the server's note the app switches its
// queries by.

/** One item's stamp to write. */
export interface Stamp {
  id: string;
  podcast: boolean;
}

/** An item as the backfill reads it: its feed and its stamp, if any. */
export interface StampRow {
  id: string;
  feedId: string;
  podcast?: unknown;
}

export interface StampStore {
  /** Whether the feed is a show in Podcasts now; a feed that is gone is not. */
  isShow(uid: string, feedId: string): Promise<boolean>;
  /** A page of one feed's items by document id, after `after`. */
  feedPage(
    uid: string,
    feedId: string,
    after: string | undefined,
    size: number,
  ): Promise<{ id: string; podcast?: unknown }[]>;
  /** Writes these stamps, leaving an item gone meanwhile gone; returns how many were written. */
  write(uid: string, stamps: Stamp[]): Promise<number>;
  /** Whether the server's note says every item is stamped (`podcastStampedAt`). */
  marked(uid: string): Promise<boolean>;
  /** Where the backfill is: when it was first asked (millis) and the last id done. */
  progress(uid: string): Promise<{ firstAt?: number; cursor?: string }>;
  saveProgress(uid: string, progress: { firstAt?: number; cursor?: string }): Promise<void>;
  /** Every feed's kind: true for a show in Podcasts, by feed id. */
  kinds(uid: string): Promise<Map<string, boolean>>;
  /** Whether any item is stored. */
  anyItem(uid: string): Promise<boolean>;
  /** A page of every item by document id, after `after`. */
  page(uid: string, after: string | undefined, size: number): Promise<StampRow[]>;
  /** Writes the server's note (`podcastStampedAt`) and clears the progress. */
  finish(uid: string): Promise<void>;
}

/** Items a page reads, and a batch writes. */
export const STAMP_PAGE = 400;
/** Pages the backfill reads in one call: ten thousand items at most. */
export const STAMP_PAGES = 25;
/**
 * How long after the backfill is first asked for a gardener before it
 * starts: longer than any function runs (nine minutes), so a look begun
 * on the code from before the stamp, still writing items without one
 * when the stamp deployed, has ended, and the pass meets every item
 * such a look wrote.
 */
export const STAMP_SETTLE_MS = 10 * 60_000;

/**
 * Whether a feed write calls for its items' restamp: the feed made
 * (a show followed again finds its saved episodes stamped the
 * Reader's), or its `kind` changed. Not a removal (`feedRemoved`
 * restamps what stays), nor the fetcher's own writes, which leave the
 * kind as it was.
 */
export function kindChanged(
  before: { exists: boolean; kind?: unknown } | undefined,
  after: { exists: boolean; kind?: unknown } | undefined,
): boolean {
  if (!after?.exists) return false;
  if (!before?.exists) return true;
  return before.kind !== after.kind;
}

/**
 * Every item of a feed stamped with the module that owns it now:
 * `podcast` true while the feed is a show in Podcasts, false in the
 * Reader or once the feed is gone (its saved and filed items stay, on
 * the Reader's Saved shelf, as before the stamp). Pages by document
 * id, writing only the items whose stamp differs, so a second run
 * writes nothing. The kind is read again at the end, and a Move during
 * the run goes round again, at most three times (the Move's own
 * trigger covers the rest). Returns how many were written.
 */
export async function restamp(
  store: StampStore,
  uid: string,
  feedId: string,
  pageSize = STAMP_PAGE,
): Promise<number> {
  let stamped = 0;
  let want = await store.isShow(uid, feedId);
  for (let round = 0; round < 3; round++) {
    let after: string | undefined;
    for (;;) {
      const page = await store.feedPage(uid, feedId, after, pageSize);
      const stale = page
        .filter((d) => d.podcast !== want)
        .map((d) => ({ id: d.id, podcast: want }));
      if (stale.length) stamped += await store.write(uid, stale);
      if (page.length < pageSize) break;
      after = page[page.length - 1].id;
    }
    const now = await store.isShow(uid, feedId);
    if (now === want) break;
    want = now;
  }
  return stamped;
}

/** What a run of the backfill did. */
export interface StampOutcome {
  /** Items whose stamp it wrote. */
  stamped: number;
  /** Every item carries the stamp: the server's note is written. */
  done: boolean;
  /** More is left that another call now would do; false while it waits to start, or once done. */
  more: boolean;
}

/**
 * The backfill: `podcast` stamped on every item stored before the
 * fetcher stamped its own, from each feed's kind (an item whose feed
 * is gone is the Reader's), in pages by document id as `indexItems`
 * pages.
 *
 * Bounded: at most `pages` pages a call. Resumable: the last id done is
 * kept after each page, and the next call goes on from it. Idempotent:
 * only a stamp that differs is written, and a gardener already marked
 * costs one read. The first call only notes the time; the pass starts
 * on a call `STAMP_SETTLE_MS` later, unless the gardener follows no
 * feed and has no item, who is marked at once. At the end the server's
 * note is written (`settings/readerServer.podcastStampedAt`), which the
 * app reads to switch its queries.
 *
 * Each feed's kind is read at the start of a call and again at its
 * end; a feed moved between is restamped whole, as a Move after the
 * second read is its own trigger's.
 */
export async function stampItems(
  store: StampStore,
  uid: string,
  now: number,
  options: { pageSize?: number; pages?: number } = {},
): Promise<StampOutcome> {
  const pageSize = options.pageSize ?? STAMP_PAGE;
  const pages = options.pages ?? STAMP_PAGES;
  if (await store.marked(uid)) return { stamped: 0, done: true, more: false };
  const progress = await store.progress(uid);
  const kinds = await store.kinds(uid);
  const finish = async (stamped: number): Promise<StampOutcome> => {
    await store.finish(uid);
    return { stamped, done: true, more: false };
  };
  if (progress.firstAt === undefined) {
    // Nothing followed and nothing stored: nothing to wait for or stamp.
    if (!kinds.size && !(await store.anyItem(uid))) return finish(0);
    await store.saveProgress(uid, { firstAt: now });
    return { stamped: 0, done: false, more: false };
  }
  let cursor = progress.cursor;
  if (cursor === undefined && now - progress.firstAt < STAMP_SETTLE_MS) {
    return { stamped: 0, done: false, more: false };
  }
  let stamped = 0;
  const settle = async () => {
    const later = await store.kinds(uid);
    for (const [id, show] of later) {
      if (kinds.has(id) && kinds.get(id) !== show) stamped += await restamp(store, uid, id);
    }
  };
  for (let n = 0; n < pages; n++) {
    const page = await store.page(uid, cursor, pageSize);
    const stale = page.flatMap((d) => {
      const want = kinds.get(d.feedId) === true;
      return d.podcast === want ? [] : [{ id: d.id, podcast: want }];
    });
    if (stale.length) stamped += await store.write(uid, stale);
    if (page.length < pageSize) {
      await settle();
      return finish(stamped);
    }
    cursor = page[page.length - 1].id;
    await store.saveProgress(uid, { cursor });
  }
  await settle();
  return { stamped, done: false, more: true };
}
