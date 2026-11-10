import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { sendDigests } from './digest';
import { firestoreDigestStore } from './digest-store';
import { fcmSender } from './fcm-sender';

/**
 * Hourly, on the hour: the daily digest (#237) to each gardener whose
 * chosen hour it is on their own clock. The claim on the day makes a
 * rerun send nothing twice.
 */
export const digestPush = onSchedule(
  // No retries: a retried run could only resend what the claim stopped.
  { schedule: '0 * * * *', timeZone: 'UTC', retryCount: 0 },
  async () => {
    const report = await sendDigests(
      firestoreDigestStore(getFirestore()),
      fcmSender(getMessaging()),
      Date.now(),
    );
    if (report.due > 0) logger.info('digestPush', report);
  },
);
