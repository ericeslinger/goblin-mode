// Refreshing feeds (#161), pure over a store and a fetcher. A tick (the
// schedule, or Refresh in the app) takes the feeds due, claims each so
// two ticks never fetch one together, asks the site conditionally, and
// writes only the items not yet stored. Each feed's interval follows
// how often it posts and backs off on errors; one that fails for about
// a month is given up until the gardener asks again.
import { FEED_CAP, feedItemId } from '@mossgoblin/schema';
import { type Enclosure, parseFeed } from './feed-parse';
import { CONTENT_MAX, htmlToMarkdown, summaryOf } from './markdown';
import { termsOf } from './terms';

/** Minutes between looks: no sooner than this, no later than a day. */
export const INTERVAL_MIN = 30;
export const INTERVAL_MAX = 24 * 60;
/** Errors in a row before a feed is given up: about a month at the longest interval. */
export const DEAD_AFTER = 35;
/** A claim this old is a lost tick's, and may be taken over. */
export const CLAIM_MS = 10 * 60_000;
/** Feeds a tick takes, and how many it fetches at once. */
export const TICK_FEEDS = 50;
export const PARALLEL = 8;
/** Items read from one response, newest first; the rest wait for the site to age them out. */
export const ITEMS_PER_FETCH = 200;
/**
 * Nothing older than this is stored (Eric, 2026-11-07): a feed's first
 * look must not bring in years of archive to be marked read by hand.
 */
export const ITEM_MAX_AGE_MS = 90 * 86_400_000;
/** A feed body over this is cut off: 5 MB is a very large feed. */
export const FEED_MAX_BYTES = 5 * 1024 * 1024;

export interface FeedResponse {
  /** 200 with a body, 304 when nothing changed, or another status to say so. */
  status: number;
  contentType: string;
  text: string;
  etag?: string;
  lastModified?: string;
}

/** Fetches a feed, conditionally when it was seen before; throws a reason when it cannot. */
export type FeedFetcher = (
  url: string,
  seen: { etag?: string; lastModified?: string },
) => Promise<FeedResponse>;

/** A feed as the store hands it to a tick. */
export interface DueFeed {
  uid: string;
  id: string;
  url: string;
  title: string;
  site?: string;
  /** The feed's artwork as last stored (#246). */
  image?: string;
  etag?: string;
  lastModified?: string;
  interval?: number;
  errorCount?: number;
  /** Milliseconds. */
  lastItemAt?: number;
  dead?: boolean;
}

/** An item as the store writes it; times in milliseconds. */
export interface NewItem {
  id: string;
  feedId: string;
  title: string;
  link: string;
  author?: string;
  published: number;
  summary: string;
  content: string;
  /** When a TTL policy removes it, from the gardener's keep-for months (#171). */
  expireAt?: number;
  /** A podcast episode's audio, artwork and number (#178), only when the feed gave them. */
  enclosure?: Enclosure;
  image?: string;
  episode?: number;
  /** The word index (#175): the title's and content's terms, for search. */
  terms: string[];
}

/** What a look at a feed changes on it; times in milliseconds, null clears. */
export interface FeedUpdate {
  title?: string;
  site?: string;
  /** The feed's own artwork (#246), when it changed; null when the feed no longer names one. */
  image?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  fetchedAt: number;
  nextFetchAt: number;
  interval: number;
  errorCount: number;
  error: string | null;
  lastItemAt?: number;
  dead?: boolean;
}

export interface RefreshStore {
  /** The feeds due at `now`, soonest first, at most `limit`; one gardener's when `uid` is given. */
  due(now: number, limit: number, uid?: string): Promise<DueFeed[]>;
  /** Claims a feed for this tick; false when a live tick has it. */
  claim(uid: string, id: string, now: number): Promise<boolean>;
  /** Which of these item ids are stored already. */
  known(uid: string, ids: string[]): Promise<Set<string>>;
  writeItems(uid: string, items: NewItem[]): Promise<void>;
  updateFeed(uid: string, id: string, update: FeedUpdate): Promise<void>;
  /** Counts a fetch in the gardener's day, for the usage record. */
  countFetch(uid: string, day: string): Promise<void>;
  /** The gardener's keep-for months (#171), or none to keep everything. */
  keepMonths(uid: string): Promise<number | undefined>;
}

export interface RefreshDeps {
  store: RefreshStore;
  fetch: FeedFetcher;
  now: () => number;
}

export type FeedOutcome = 'new' | 'unchanged' | 'failed' | 'skipped';

export interface TickReport {
  fetched: number;
  added: number;
  failed: number;
  skipped: number;
}

/** UTC day, YYYY-MM-DD. */
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `months` calendar months after `ms`, in UTC. */
export function monthsAfter(ms: number, months: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

const clamp = (minutes: number) =>
  Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(minutes)));

/**
 * How long to wait before the next look, in minutes: half the median
 * gap between recent items, and no less than a quarter of the quiet
 * since the last one, so a feed that posts hourly is read every half
 * hour and one silent for a month once a day.
 */
export function nextInterval(
  published: readonly number[],
  lastItemAt: number | undefined,
  now: number,
): number {
  const times = [...published].sort((a, b) => b - a).slice(0, 10);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i - 1] - times[i]);
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] / 60_000 : 60;
  const quiet = lastItemAt === undefined ? 0 : (now - lastItemAt) / 60_000 / 4;
  return clamp(Math.max(median / 2, quiet));
}

/** The interval after an error: double, up to a day. */
export function backoff(interval: number | undefined): number {
  return clamp((interval ?? INTERVAL_MIN) * 2);
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** Looks at one feed. The claim is the caller's; this never skips. */
export async function refreshFeed(
  deps: RefreshDeps,
  feed: DueFeed,
): Promise<{ outcome: FeedOutcome; added: number }> {
  const now = deps.now();
  const { store } = deps;
  await store.countFetch(feed.uid, dayOf(now)).catch(() => undefined);
  const failed = async (message: string) => {
    const errorCount = (feed.errorCount ?? 0) + 1;
    const dead = errorCount >= DEAD_AFTER;
    const interval = backoff(feed.interval);
    await store.updateFeed(feed.uid, feed.id, {
      fetchedAt: now,
      nextFetchAt: now + interval * 60_000,
      interval,
      errorCount,
      error: message.slice(0, 300),
      ...(dead ? { dead: true } : {}),
    });
    return { outcome: 'failed' as const, added: 0 };
  };
  let res: FeedResponse;
  try {
    res = await deps.fetch(feed.url, { etag: feed.etag, lastModified: feed.lastModified });
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  if (res.status === 304) {
    const interval = nextInterval([], feed.lastItemAt, now);
    await store.updateFeed(feed.uid, feed.id, {
      fetchedAt: now,
      nextFetchAt: now + interval * 60_000,
      interval,
      errorCount: 0,
      error: null,
    });
    return { outcome: 'unchanged', added: 0 };
  }
  if (res.status < 200 || res.status >= 300) return failed(`the site answered ${res.status}`);
  const parsed = parseFeed(res.text, feed.url);
  if (!parsed) return failed('not a feed this can read (RSS, Atom or JSON Feed)');
  // Everything the feed lists, newest first, for its rhythm; only the
  // recent ones (ITEM_MAX_AGE_MS) are stored, so a first look is not a
  // feed's archive, and a dormant feed still gets its daily interval
  // (review on #170).
  const all = parsed.items
    .map((i) => ({ ...i, published: Math.min(i.published ?? now, now + 86_400_000) }))
    .sort((a, b) => b.published - a.published);
  const items = all.filter((i) => now - i.published <= ITEM_MAX_AGE_MS).slice(0, ITEMS_PER_FETCH);
  const ids = items.map((i) => feedItemId(feed.id, i.guid));
  const known = ids.length ? await store.known(feed.uid, ids) : new Set<string>();
  const keep = items.length ? await store.keepMonths(feed.uid) : undefined;
  const fresh: NewItem[] = [];
  items.forEach((item, n) => {
    if (known.has(ids[n])) return;
    const content = htmlToMarkdown(item.html, item.link || feed.url).slice(0, CONTENT_MAX + 3);
    const title = item.title || hostOf(item.link || feed.url);
    fresh.push({
      id: ids[n],
      feedId: feed.id,
      title,
      link: item.link,
      ...(item.author ? { author: item.author.slice(0, 200) } : {}),
      published: item.published,
      summary: summaryOf(content),
      content,
      ...(keep ? { expireAt: monthsAfter(item.published, keep) } : {}),
      ...(item.enclosure ? { enclosure: item.enclosure } : {}),
      ...(item.image ? { image: item.image } : {}),
      ...(item.episode === undefined ? {} : { episode: item.episode }),
      terms: termsOf(title, content),
    });
  });
  if (fresh.length) await store.writeItems(feed.uid, fresh);
  const newest = all.reduce((m, i) => Math.max(m, i.published), feed.lastItemAt ?? 0);
  const interval = nextInterval(
    all.map((i) => i.published),
    newest || undefined,
    now,
  );
  // A feed named by its address or host until now takes the feed's own name.
  const unnamed = !feed.title || feed.title === feed.url || feed.title === hostOf(feed.url);
  await store.updateFeed(feed.uid, feed.id, {
    ...(unnamed && parsed.title ? { title: parsed.title.slice(0, 200) } : {}),
    ...(!feed.site && parsed.site ? { site: parsed.site } : {}),
    // The feed's own artwork (#246), kept as the feed names it now.
    ...((parsed.image ?? undefined) !== feed.image ? { image: parsed.image ?? null } : {}),
    etag: res.etag ?? null,
    lastModified: res.lastModified ?? null,
    fetchedAt: now,
    nextFetchAt: now + interval * 60_000,
    interval,
    errorCount: 0,
    error: null,
    ...(newest ? { lastItemAt: newest } : {}),
    // No kind: whether a feed is a podcast is the gardener's, by where
    // it was added or moved (#245, Eric 2026-11-10), never the audio's.
  });
  return { outcome: fresh.length ? 'new' : 'unchanged', added: fresh.length };
}

/**
 * One tick: the feeds due now, claimed and refreshed `PARALLEL` at a
 * time. A feed given up (`dead`) waits for the gardener; one another
 * tick holds is skipped.
 */
export async function refreshDue(
  deps: RefreshDeps,
  options: { uid?: string; limit?: number } = {},
): Promise<TickReport> {
  const now = deps.now();
  const due = (await deps.store.due(now, options.limit ?? TICK_FEEDS, options.uid)).filter(
    (f) => !f.dead,
  );
  const report: TickReport = { fetched: 0, added: 0, failed: 0, skipped: 0 };
  const queue = [...due];
  const worker = async () => {
    for (let feed = queue.shift(); feed; feed = queue.shift()) {
      if (!(await deps.store.claim(feed.uid, feed.id, now))) {
        report.skipped++;
        continue;
      }
      const { outcome, added } = await refreshFeed(deps, feed);
      report.fetched++;
      report.added += added;
      if (outcome === 'failed') report.failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, Math.max(due.length, 1)) }, worker));
  return report;
}

export { FEED_CAP };
