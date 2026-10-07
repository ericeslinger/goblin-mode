import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { fcmSender } from './fcm-sender';
import { cloudWakeQueue } from './cloud-tasks';
import { firestoreStore, upcomingReminders } from './firestore-store';
import { BATCH, sendDue } from './send-due';
import { UPCOMING_MS, wakeUpcoming } from './wake';

/**
 * Hourly, a safety net: push each reminder whose `nextFireAt` has come.
 * A reminder's own Cloud Task wakes sendDue on time (reminder-wake.ts);
 * this catches one a task missed (2026-10-07, was every minute).
 */
export const sendDuePush = onSchedule(
  // No retries: a retried run could only resend what the claim stopped.
  { schedule: 'every 60 minutes', timeZone: 'UTC', retryCount: 0 },
  async () => {
    const now = Date.now();
    const db = getFirestore();
    const report = await sendDue(firestoreStore(db), fcmSender(getMessaging()), now);
    if (report.claimed > 0) logger.info('sendDuePush', report);
    // Wakes for the next hour's pushes, in case a task was missed.
    const upcoming = await upcomingReminders(db, now, now + UPCOMING_MS, BATCH);
    await wakeUpcoming(cloudWakeQueue(), upcoming, now);
  },
);
