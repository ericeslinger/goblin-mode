// What went wrong with a feed, from what the fetcher stored (#161), in
// words Eric can act on, and the fixes that fit (2026-11-15). Pure, so
// Manage feeds' attention section, a feed's page and a show's page
// read alike, and specs need no component.
import type { FeedRecord } from './reader.service';

/**
 * Statuses a site answers when it will not let a server read it: the
 * saved-link importer's `REFUSING_STATUSES` (functions, 2026-11-14),
 * kept here as the app cannot import the functions package.
 */
export const REFUSING = new Set([401, 402, 403, 429, 451]);

/**
 * What went wrong, by what the fetcher stores in `error`:
 * - `moved`: the address answers 404 or 410, or another 4xx, or a
 *   redirect that goes nowhere: the feed is likely elsewhere now;
 * - `not-a-feed`: the address answers with something that is not a
 *   feed ("not a feed this can read");
 * - `refused`: 401, 402, 403, 429 or 451;
 * - `no-host`: the site's name does not resolve (`ENOTFOUND`,
 *   `EAI_AGAIN`, `ENODATA`) or resolves to no public address;
 * - `unreachable`: the connection failed, timed out or its TLS did
 *   not hold (`fetch failed`, the timeout's words, a socket's code);
 * - `down`: the site answered 5xx;
 * - `other`: anything else (too large, too many redirects, an error
 *   this list does not know), shown as stored;
 * - `dead`: given up after a month of failed looks.
 */
export type TroubleKind =
  'moved' | 'not-a-feed' | 'refused' | 'no-host' | 'unreachable' | 'down' | 'other' | 'dead';

/** A fix offered for a feed in trouble. */
export type Fix = 'find' | 'retry' | 'remove';

export interface Trouble {
  kind: TroubleKind;
  /** What went wrong, in plain words, ending in a full stop. */
  words: string;
  /** The fixes that fit, most likely first. */
  fixes: Fix[];
  /**
   * Its place in the attention list: the ones a new address may fix
   * first (0), then a site that refuses (1), then a site that may be
   * gone (2), then the given up (3).
   */
  rank: number;
}

/** The HTTP status in the fetcher's "the site answered 404", if that is what it stored. */
export function answeredStatus(error: string): number | undefined {
  const m = /answered (\d{3})\b/.exec(error);
  return m ? Number(m[1]) : undefined;
}

/** What went wrong with the stored error alone, before `dead` is weighed. */
function classify(error: string): TroubleKind {
  const status = answeredStatus(error);
  if (status !== undefined) {
    if (REFUSING.has(status)) return 'refused';
    if (status >= 500) return 'down';
    if (status >= 400) return 'moved';
    return 'other';
  }
  const e = error.toLowerCase();
  if (e.startsWith('not a feed')) return 'not-a-feed';
  if (/redirect with nowhere to go/.test(e)) return 'moved';
  if (/enotfound|eai_again|enodata|eai_noname|is not a public address/.test(e)) return 'no-host';
  if (
    /fetch failed|timeout|timed out|aborted|econnrefused|econnreset|etimedout|ehostunreach|enetunreach|socket|certificate|cert_|ssl|tls|terminated/.test(
      e,
    )
  ) {
    return 'unreachable';
  }
  return 'other';
}

/** Words for each kind; `status` and the stored text fill them in. */
function wordsFor(kind: TroubleKind, error: string): string {
  const status = answeredStatus(error);
  switch (kind) {
    case 'moved':
      if (status === 404)
        return 'The address answers 404: nothing is there now. The feed may have moved.';
      if (status === 410) return 'The address answers 410: the site says it is gone from there.';
      if (status !== undefined)
        return `The address answers ${status}, not a feed. The feed may have moved.`;
      return 'The address redirects to nowhere. The feed may have moved.';
    case 'not-a-feed':
      return 'The address answers with a page, not a feed. The site may name its feed elsewhere.';
    case 'refused':
      return `The site does not let Mossgoblin read it (it answered ${status}).`;
    case 'no-host':
      return 'The site’s name leads nowhere now. It may be gone.';
    case 'unreachable':
      return 'The site could not be reached: no connection, a timeout or a broken certificate. It may be down, or gone.';
    case 'down':
      return `The site answered ${status}: it is having trouble. It may be down for a while, or gone.`;
    default:
      return `The last look failed: ${error.replace(/\.$/, '')}.`;
  }
}

const RANK: Record<TroubleKind, number> = {
  moved: 0,
  'not-a-feed': 0,
  refused: 1,
  'no-host': 2,
  unreachable: 2,
  down: 2,
  other: 2,
  dead: 3,
};

/**
 * What is wrong with a feed and what to do about it, or undefined when
 * its last look went well (or it has no link to look at: the Feedly
 * saves, #176).
 */
export function feedTrouble(feed: FeedRecord): Trouble | undefined {
  if (!feed.url) return undefined;
  if (!feed.dead && !feed.error) return undefined;
  const error = feed.error ?? '';
  const kind = error ? classify(error) : 'other';
  if (feed.dead) {
    const why = error ? ` The last answer: ${wordsFor(kind, error)}` : '';
    return {
      kind: 'dead',
      words: `Given up after a month of failed looks.${why}`,
      fixes: ['retry', 'find', 'remove'],
      rank: RANK.dead,
    };
  }
  const fixes: Fix[] =
    kind === 'moved' || kind === 'not-a-feed'
      ? ['find', 'remove']
      : kind === 'refused'
        ? ['retry', 'remove']
        : ['retry', 'find', 'remove'];
  return { kind, words: wordsFor(kind, error), fixes, rank: RANK[kind] };
}

/** A feed in trouble, with what is wrong. */
export interface Attention {
  feed: FeedRecord;
  trouble: Trouble;
}

/**
 * The feeds that need attention, the fixable first, then those whose
 * site refuses, then those that may be gone, then the given up; by name
 * within each.
 */
export function needsAttention(feeds: readonly FeedRecord[]): Attention[] {
  return feeds
    .flatMap((feed) => {
      const trouble = feedTrouble(feed);
      return trouble ? [{ feed, trouble }] : [];
    })
    .sort(
      (a, b) =>
        a.trouble.rank - b.trouble.rank ||
        a.feed.title.localeCompare(b.feed.title, undefined, { sensitivity: 'base' }),
    );
}

/**
 * Where Find the feed looks: the feed's site when the fetcher or the
 * file named one, else the home page of the feed's own host, where a
 * site names its feeds (`<link rel="alternate">`, #174).
 */
export function findTarget(feed: FeedRecord): string {
  if (feed.site) return feed.site;
  try {
    return `${new URL(feed.url).origin}/`;
  } catch {
    return feed.url;
  }
}

/** A span of time in words: "just now", "12 min", "3 h", "5 days", "4 months", "2 years". */
function span(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '';
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  const days = Math.round(h / 24);
  if (days < 60) return `${days} days`;
  const months = Math.round(days / 30.4);
  if (months < 24) return `${months} months`;
  return `${Math.round(days / 365)} years`;
}

/** When something happened, from now: "just now", "3 h ago". */
export function agoText(at: number, now: number): string {
  const s = span(Math.max(0, now - at));
  return s ? `${s} ago` : 'just now';
}

/** When something is due, from now: "in 3 h", or "soon" once due. */
export function dueText(at: number, now: number): string {
  const s = span(at - now);
  return at <= now || !s ? 'soon' : `in ${s}`;
}

/**
 * How the feed's looks have gone, for a page: "3 looks in a row have
 * failed, the last 2 h ago", or when it was last looked at.
 */
export function looksText(feed: FeedRecord, now: number): string {
  if (feed.fetchedAt === undefined) return 'Not looked at yet.';
  const last = agoText(feed.fetchedAt, now);
  const n = feed.errorCount ?? 0;
  if (n > 1) return `${n} looks in a row have failed, the last ${last}.`;
  if (n === 1 || feed.error) return `The last look failed, ${last}.`;
  return `Last looked at ${last}.`;
}

/** When the newest article was, which says how stale a feed is. */
export function newestText(feed: FeedRecord, now: number): string {
  return feed.lastItemAt === undefined
    ? 'No article read from it yet.'
    : `Newest article ${agoText(feed.lastItemAt, now)}.`;
}

/** When the server will look next. */
export function nextText(feed: FeedRecord, now: number): string {
  if (feed.dead) return 'Not looked at again until you try again.';
  if (feed.nextFetchAt === undefined) return 'Looked at on the server’s next round.';
  // The server's round is every 15 minutes (#161), so "soon" is within that.
  return feed.nextFetchAt <= now
    ? 'Next look on the server’s next round, within 15 minutes.'
    : `Next look ${dueText(feed.nextFetchAt, now)}.`;
}

/** Whether a feed's title is only its address or its host: named by the server, not by Eric or the feed. */
export function unnamed(feed: Pick<FeedRecord, 'title' | 'url'>): boolean {
  if (!feed.title || feed.title === feed.url) return true;
  try {
    return feed.title === new URL(feed.url).hostname;
  } catch {
    return false;
  }
}
