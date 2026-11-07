// The Reader's functions (#161): the schedule that keeps feeds fresh,
// Refresh from the app (onCall, as everything the app asks the server
// to do is), and the trigger that takes a removed feed's items with it.
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FEED_CAP, paths } from '@mossgoblin/schema';
import { feedFetch } from './fetch';
import { firestoreRefreshStore, markAllDue, removeFeedItems } from './firestore-store';
import { type RefreshDeps, refreshDue } from './refresh';
import { standInFeedFetcher } from './stand-in';

/** Refresh in the app no more often than this, per gardener. */
export const REFRESH_EVERY_MS = 5 * 60_000;

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
