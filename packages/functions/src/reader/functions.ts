// The Reader's functions (#161): the schedule that keeps feeds fresh,
// Refresh from the app (onCall, as everything the app asks the server
// to do is), and the trigger that takes a removed feed's items with it.
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FEED_CAP, paths } from '@mossgoblin/schema';
import { publicFetch } from '../attachments/import';
import { readerMarkdown } from './article';
import { decodeBody, feedFetch } from './fetch';
import { firestoreRefreshStore, markAllDue, removeFeedItems } from './firestore-store';
import { type RefreshDeps, refreshDue } from './refresh';
import { standInFeedFetcher, standInPageFetcher } from './stand-in';

/** Refresh in the app no more often than this, per gardener. */
export const REFRESH_EVERY_MS = 5 * 60_000;
/** Reader-mode fetches a day per gardener, counted in the usage record. */
export const DAILY_ARTICLES = 50;
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

/** A feed removed: its unread, unsaved, unfiled articles go with it. */
export const feedRemoved = onDocumentDeleted(
  { document: 'users/{uid}/feeds/{feedId}', timeoutSeconds: 300 },
  async (event) => {
    const { uid, feedId } = event.params;
    const removed = await removeFeedItems(getFirestore(), uid, feedId);
    logger.info('feedRemoved', { feedId, removed });
  },
);

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
    return { done: false as const, link: String(d['link'] ?? '') };
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
