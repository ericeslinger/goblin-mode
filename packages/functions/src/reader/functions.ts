// The Reader's functions (#161): the schedule that keeps feeds fresh,
// Refresh from the app (onCall, as everything the app asks the server
// to do is), and the trigger that takes a removed feed's items with it.
import {
  type DocumentSnapshot,
  FieldValue,
  Timestamp,
  getFirestore,
} from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentDeleted, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FEED_CAP, paths } from '@mossgoblin/schema';
import { publicFetch } from '../attachments/import';
import { readerMarkdown } from './article';
import { discoverFeeds as discover } from './discover';
import { DAILY_IMPORTS, importSaves, readEntries } from './feedly';
import { decodeBody, discoverFeedFetch, discoverPageFetch, feedFetch } from './fetch';
import {
  applyRetention,
  firestoreRefreshStore,
  indexItems,
  firestoreSavesStore,
  markAllDue,
  removeFeedItems,
  firestoreStampStore,
  restampFeed,
  searchItems,
  sweepOld,
} from './firestore-store';
import { ITEM_MAX_AGE_MS, type RefreshDeps, refreshDue } from './refresh';
import { kindChanged, stampItems } from './stamp';
import { standInFeedFetcher, standInPageFetcher } from './stand-in';
import { termsOfItem } from './terms';

/** Refresh in the app no more often than this, per gardener. */
export const REFRESH_EVERY_MS = 5 * 60_000;
/** Reader-mode fetches a day per gardener, counted in the usage record. */
export const DAILY_ARTICLES = 50;
/** Feed discoveries a day per gardener (#174), counted in the usage record. */
export const DAILY_DISCOVERIES = 50;
/** Index articles for search, once a day per gardener (#175): new ones are indexed as fetched. */
export const DAILY_INDEXES = 1;
/** Searches from the app a day per gardener (review on #197), counted in the usage record. */
export const DAILY_SEARCHES = 500;
/** Runs of the module stamp's backfill a day per gardener (#248), counted in the usage record. */
export const DAILY_STAMPS = 24;
/** A reader-mode fetch claimed this long ago is a lost one's, and may be asked again. */
const ARTICLE_STALE_MS = 2 * 60_000;

function deps(): RefreshDeps {
  return {
    store: firestoreRefreshStore(getFirestore()),
    fetch: standInFeedFetcher(process.env) ?? feedFetch,
    now: () => Date.now(),
  };
}

/** Every quarter hour: the feeds due, fifty at a time, eight at once. */
export const feedsRefresh = onSchedule(
  // No retries: a retried tick could only fetch what the claims stopped.
  {
    schedule: 'every 15 minutes',
    timeZone: 'UTC',
    retryCount: 0,
    memory: '512MiB',
    timeoutSeconds: 540,
  },
  async () => {
    const report = await refreshDue(deps());
    if (report.fetched || report.skipped) logger.info('feedsRefresh', report);
  },
);

/**
 * Refresh, from the app: every live feed of the caller is due now and
 * looked at before this returns. Once in five minutes per gardener;
 * the day's usage record keeps the time.
 */
export const refreshFeeds = onCall({ memory: '512MiB', timeoutSeconds: 300 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = request.auth.uid;
  const db = getFirestore();
  const now = Date.now();
  const usageRef = db.doc(paths.usage(uid, new Date(now).toISOString().slice(0, 10)));
  await db.runTransaction(async (tx) => {
    const last = (await tx.get(usageRef)).data()?.['feedRefreshAt'];
    const at = last instanceof Timestamp ? last.toMillis() : 0;
    if (now - at < REFRESH_EVERY_MS) {
      const wait = Math.ceil((REFRESH_EVERY_MS - (now - at)) / 60_000);
      throw new HttpsError(
        'resource-exhausted',
        `Refreshed a moment ago; the next is in ${wait} ${wait === 1 ? 'minute' : 'minutes'}.`,
      );
    }
    tx.set(usageRef, { feedRefreshAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  try {
    const feeds = await markAllDue(db, uid, now);
    const report = await refreshDue(deps(), { uid, limit: FEED_CAP });
    logger.info('refreshFeeds', { feeds, ...report });
    return report;
  } catch (err) {
    // A failed refresh is not one to wait five minutes on (review on #166).
    await usageRef
      .set({ feedRefreshAt: FieldValue.delete() }, { merge: true })
      .catch(() => undefined);
    throw err;
  }
});

/**
 * A feed removed: its unread, unsaved, unfiled articles go with it.
 * What stays (saved or filed) is stamped the Reader's (#248), where
 * the Saved shelf has always shown it once its feed was gone.
 */
export const feedRemoved = onDocumentDeleted(
  { document: 'users/{uid}/feeds/{feedId}', timeoutSeconds: 300 },
  async (event) => {
    const { uid, feedId } = event.params;
    const db = getFirestore();
    const removed = await removeFeedItems(db, uid, feedId);
    const stamped = await restampFeed(db, uid, feedId);
    logger.info('feedRemoved', { feedId, removed, stamped });
  },
);

/**
 * A feed moved between the Reader and Podcasts (#248): its items are
 * restamped with the module that owns them now (`podcast`), which the
 * owner's rules never let the app write. Every feed write fires it,
 * the fetcher's included; it reads nothing unless the write changed
 * `kind`, or made the feed (a show followed again finds its saved
 * episodes stamped the Reader's when it left). The kind restamped is
 * read from the feed as it is when the run starts, not from the event,
 * so events out of order still end at the feed's kind; running twice
 * writes nothing the second time. A removed feed is `feedRemoved`'s.
 */
export const feedKindChanged = onDocumentWritten(
  { document: 'users/{uid}/feeds/{feedId}', timeoutSeconds: 300 },
  async (event) => {
    const shape = (d?: DocumentSnapshot) => d && { exists: d.exists, kind: d.get('kind') };
    if (!kindChanged(shape(event.data?.before), shape(event.data?.after))) return;
    const { uid, feedId } = event.params;
    const stamped = await restampFeed(getFirestore(), uid, feedId);
    logger.info('feedKindChanged', { feedId, stamped });
  },
);

/**
 * The module stamp's backfill (#248), asked by the app on its own
 * while `settings/readerServer` has no `podcastStampedAt`: one run of
 * `stampItems`, ten thousand items at most, going on from where the
 * last stopped. onCall, as everything the app asks the server to do
 * is; signed in, and at most 24 runs a day per gardener (`stampRuns`
 * in the usage record), given back when the run fails.
 */
export const stampFeedItems = onCall({ timeoutSeconds: 540, memory: '512MiB' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = request.auth.uid;
  const db = getFirestore();
  const usageRef = db.doc(paths.usage(uid, new Date().toISOString().slice(0, 10)));
  await db.runTransaction(async (tx) => {
    const used = Number((await tx.get(usageRef)).data()?.['stampRuns'] ?? 0);
    if (used >= DAILY_STAMPS) {
      throw new HttpsError('resource-exhausted', 'Stamped enough for today; it goes on tomorrow.');
    }
    tx.set(usageRef, { stampRuns: used + 1 }, { merge: true });
  });
  try {
    const outcome = await stampItems(firestoreStampStore(db), uid, Date.now());
    logger.info('stampFeedItems', outcome);
    return outcome;
  } catch (err) {
    await usageRef
      .set({ stampRuns: FieldValue.increment(-1) }, { merge: true })
      .catch(() => undefined);
    throw err;
  }
});

/**
 * Reader mode (#163), from the app: the article's page is fetched and
 * its main content kept on the item as markdown, so it reads offline
 * from then on. onCall, as everything the app asks the server to do
 * is; the page reaches no model. Claimed in a transaction and counted
 * in the day's usage record, as transcriptions are.
 */
export const fetchArticle = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = request.auth.uid;
  const itemId = (request.data as { itemId?: unknown } | null)?.itemId;
  if (typeof itemId !== 'string' || !itemId)
    throw new HttpsError('invalid-argument', 'Which article?');
  const db = getFirestore();
  const ref = db.doc(paths.feedItem(uid, itemId));
  const now = Date.now();
  const usageRef = db.doc(paths.usage(uid, new Date(now).toISOString().slice(0, 10)));
  const claim = await db.runTransaction(async (tx) => {
    const [doc, usage] = await Promise.all([tx.get(ref), tx.get(usageRef)]);
    const d = doc.data();
    if (!d) throw new HttpsError('not-found', 'No such article.');
    if (d['readerState'] === 'done') return { done: true as const };
    const since = d['updatedAt'] instanceof Timestamp ? d['updatedAt'].toMillis() : 0;
    if (d['readerState'] === 'working' && now - since < ARTICLE_STALE_MS) {
      throw new HttpsError('already-exists', 'Already fetching it.');
    }
    const used = Number(usage.data()?.['articles'] ?? 0);
    if (used >= DAILY_ARTICLES) {
      throw new HttpsError(
        'resource-exhausted',
        `Today’s ${DAILY_ARTICLES} reader-mode fetches are used up; try again tomorrow.`,
      );
    }
    tx.set(usageRef, { articles: used + 1 }, { merge: true });
    tx.update(ref, {
      readerState: 'working',
      readerError: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      done: false as const,
      link: String(d['link'] ?? ''),
      title: String(d['title'] ?? ''),
      content: String(d['content'] ?? ''),
    };
  });
  if (claim.done) return { state: 'done' };
  try {
    if (!/^https?:\/\//.test(claim.link)) throw new Error('the article has no web link');
    const res = await (standInPageFetcher(process.env) ?? publicFetch)(claim.link);
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(res.contentType)) {
      throw new Error('the page is not HTML');
    }
    const markdown = readerMarkdown(decodeBody(res.bytes, res.contentType), claim.link);
    if (markdown.length < 80) throw new Error('could not find the article on the page');
    await ref.update({
      readerState: 'done',
      readerContent: markdown,
      // The page's words join the index (#175), so search finds them too.
      terms: termsOfItem({ title: claim.title, content: claim.content, readerContent: markdown }),
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.info('fetchArticle', { itemId, chars: markdown.length });
    return { state: 'done', chars: markdown.length };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await ref
      .update({
        readerState: 'failed',
        readerError: message,
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => undefined);
    throw new HttpsError('unavailable', `Could not fetch the page: ${message}`);
  }
});

/**
 * Feed discovery (#174), from Manage feeds: the feeds at a site's
 * address, each confirmed by parsing it, with its own name. onCall, as
 * everything the app asks the server to do is; the page reaches no
 * model. Counted in the day's usage record, fifty a day per gardener.
 */
export const discoverFeeds = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = request.auth.uid;
  const raw = (request.data as { url?: unknown } | null)?.url;
  let url: string;
  try {
    const parsed = new URL(typeof raw === 'string' ? raw.trim() : '');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http');
    parsed.hash = '';
    url = parsed.toString();
  } catch {
    throw new HttpsError(
      'invalid-argument',
      'That is not a link. Paste one starting with https://.',
    );
  }
  const db = getFirestore();
  const usageRef = db.doc(paths.usage(uid, new Date().toISOString().slice(0, 10)));
  await db.runTransaction(async (tx) => {
    const used = Number((await tx.get(usageRef)).data()?.['discoveries'] ?? 0);
    if (used >= DAILY_DISCOVERIES) {
      throw new HttpsError(
        'resource-exhausted',
        `Today’s ${DAILY_DISCOVERIES} looks for feeds are used up; try again tomorrow.`,
      );
    }
    tx.set(usageRef, { discoveries: used + 1 }, { merge: true });
  });
  let found;
  try {
    found = await discover(
      url,
      standInPageFetcher(process.env) ?? discoverPageFetch,
      standInFeedFetcher(process.env) ?? discoverFeedFetch,
    );
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    throw new HttpsError('unavailable', `Could not look at that address: ${message}`);
  }
  logger.info('discoverFeeds', { feeds: found.feeds.length });
  if (!found.feeds.length) throw new HttpsError('not-found', 'No feed found at that address.');
  return found;
});

/**
 * Retention (#171), from Settings: applies the keep-for months to the
 * articles already stored (`expireAt` set or cleared), after the app
 * has written the setting. onCall, as everything the app asks the
 * server to do is.
 */
export const applyRetentionNow = onCall({ timeoutSeconds: 300 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = request.auth.uid;
  // The months come with the call (review on #181): the app's write of
  // the setting is still on its way, so a read here could be stale.
  const months = (request.data as { keepMonths?: unknown } | null)?.keepMonths;
  if (months !== null && months !== undefined && !validMonths(months)) {
    throw new HttpsError('invalid-argument', 'keepMonths is whole months, 1 to 120, or null.');
  }
  const keep = validMonths(months) ? months : undefined;
  const touched = await applyRetention(getFirestore(), uid, keep);
  logger.info('applyRetention', { keep, touched });
  return { keepMonths: keep ?? null, touched };
});

/** Whole months, 1 to 120: what the setting may hold (review on #181). */
const validMonths = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 120;

/** Removes the unread, unsaved, unfiled articles older than the fetcher's cutoff (#171). */
export const sweepArticles = onCall({ timeoutSeconds: 300 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = request.auth.uid;
  const removed = await sweepOld(getFirestore(), uid, Date.now() - ITEM_MAX_AGE_MS);
  logger.info('sweepArticles', { removed });
  return { removed };
});

/**
 * Index articles for search (#175), from Settings: the word index
 * written on the articles stored before it, or whose index is out of
 * date, in pages by document id. Once a day per gardener (`indexRuns`
 * in the usage record), given back when the run fails; the fetcher
 * indexes new articles itself.
 */
export const indexArticles = onCall({ timeoutSeconds: 540, memory: '512MiB' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = request.auth.uid;
  const db = getFirestore();
  const usageRef = db.doc(paths.usage(uid, new Date().toISOString().slice(0, 10)));
  await db.runTransaction(async (tx) => {
    const used = Number((await tx.get(usageRef)).data()?.['indexRuns'] ?? 0);
    if (used >= DAILY_INDEXES) {
      throw new HttpsError(
        'resource-exhausted',
        'Indexed today already; new articles are indexed as they arrive. Try again tomorrow.',
      );
    }
    tx.set(usageRef, { indexRuns: used + 1 }, { merge: true });
  });
  try {
    const indexed = await indexItems(db, uid);
    logger.info('indexArticles', { indexed });
    return { indexed };
  } catch (err) {
    await usageRef
      .set({ indexRuns: FieldValue.increment(-1) }, { merge: true })
      .catch(() => undefined);
    throw err;
  }
});

/** What the app's search shows of an article (#175): a row's worth, no text. */
function searchHit(id: string, d: FirebaseFirestore.DocumentData) {
  const published = d['published'] instanceof Timestamp ? d['published'].toMillis() : 0;
  return {
    id,
    feedId: String(d['feedId'] ?? ''),
    title: String(d['title'] ?? ''),
    link: typeof d['link'] === 'string' ? d['link'] : '',
    published,
    summary: String(d['summary'] ?? ''),
    read: d['read'] === true,
    saved: d['saved'] === true,
    ...(typeof d['noteId'] === 'string' ? { noteId: d['noteId'] } : {}),
  };
}

/**
 * Search across every article (#175), from the Reader's front: the
 * word index (`searchItems`), newest first, a row's worth of each.
 * onCall, as everything the app asks the server to do is. A search
 * reads at most 250 documents from the index, plus up to 500 from the
 * recent scan while the index may be incomplete; five hundred a day
 * per gardener (`searches` in the usage record, review on #197).
 */
export const searchArticles = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const data = request.data as { q?: unknown; limit?: unknown } | null;
  const q = typeof data?.q === 'string' ? data.q.trim().slice(0, 200) : '';
  if (!q) throw new HttpsError('invalid-argument', 'Search for a word.');
  const limit =
    typeof data?.limit === 'number' && Number.isInteger(data.limit)
      ? Math.min(Math.max(1, data.limit), 50)
      : 20;
  const uid = request.auth.uid;
  const db = getFirestore();
  const usageRef = db.doc(paths.usage(uid, new Date().toISOString().slice(0, 10)));
  await db.runTransaction(async (tx) => {
    const used = Number((await tx.get(usageRef)).data()?.['searches'] ?? 0);
    if (used >= DAILY_SEARCHES) {
      throw new HttpsError(
        'resource-exhausted',
        `Today’s ${DAILY_SEARCHES} searches are used up; try again tomorrow.`,
      );
    }
    tx.set(usageRef, { searches: used + 1 }, { merge: true });
  });
  const found = await searchItems(db, uid, q, { limit });
  return {
    items: found.items.map((f) => searchHit(f.id, f.data)),
    // Five pages of the index read with more behind them (review on #197).
    truncated: found.truncated,
  };
});

/**
 * Feedly's saves and boards (#176), from Manage feeds: a batch of at
 * most a hundred entries the app read out of Feedly's full export,
 * each stored as a saved, read article, its boards its tags. onCall,
 * as everything the app asks the server to do is; the HTML reaches no
 * model and is kept as escaped markdown, as a feed's is. Counted in
 * the day's usage record (`imports`) by what is added, so the same
 * file again tomorrow spends nothing on what came today.
 */
export const importFeedlySaves = onCall(
  { memory: '512MiB', timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    const uid = request.auth.uid;
    let read;
    try {
      read = readEntries(request.data);
    } catch (err) {
      throw new HttpsError('invalid-argument', err instanceof Error ? err.message : String(err));
    }
    const db = getFirestore();
    const now = Date.now();
    const usageRef = db.doc(paths.usage(uid, new Date(now).toISOString().slice(0, 10)));
    const used = Number((await usageRef.get()).data()?.['imports'] ?? 0);
    if (used >= DAILY_IMPORTS) {
      throw new HttpsError(
        'resource-exhausted',
        `Today’s ${DAILY_IMPORTS} imported articles are used up; import the same file tomorrow for the rest.`,
      );
    }
    const outcome = await importSaves(firestoreSavesStore(db), uid, read.entries, now);
    if (outcome.added) {
      await usageRef.set({ imports: FieldValue.increment(outcome.added) }, { merge: true });
    }
    logger.info('importFeedlySaves', {
      added: outcome.added,
      known: outcome.known,
      skipped: read.skipped,
    });
    return { ...outcome, skipped: read.skipped };
  },
);
