import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { fcmSender } from './fcm-sender';
import { firestoreStore } from './firestore-store';
import { sendDue } from './send-due';

/** Every minute: push each reminder whose `nextFireAt` has come. */
export const sendDuePush = onSchedule(
  // No retries: a retried run could only resend what the claim stopped.
  { schedule: 'every 1 minutes', timeZone: 'UTC', retryCount: 0 },
  async () => {
    const report = await sendDue(
      firestoreStore(getFirestore()),
      fcmSender(getMessaging()),
      Date.now(),
    );
    if (report.claimed > 0) logger.info('sendDuePush', report);
  },
);
