import { paths } from '@mossgoblin/schema';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { cloudWakeQueue } from './cloud-tasks';
import { fcmSender } from './fcm-sender';
import { firestoreStore } from './firestore-store';
import { sendDue } from './send-due';
import { wakeFor } from './wake';

const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined);

/** A reminder's push time is new: queue a wake for it. */
export const reminderScheduled = onDocumentWritten(
  'users/{uid}/reminders/{reminderId}',
  async (event) => {
    const { uid, reminderId } = event.params;
    const before = millis(event.data?.before.get('nextFireAt'));
    const after = event.data?.after.exists ? millis(event.data.after.get('nextFireAt')) : undefined;
    await wakeFor(cloudWakeQueue(), uid, reminderId, before, after, Date.now());
  },
);

/**
 * A wake: push whatever is due (a claim stops any double send), then,
 * for a push still further off than a task reaches, queue the next hop.
 */
export const reminderWake = onTaskDispatched<{ uid: string; id: string }>(
  { retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 } },
  async (req) => {
    const now = Date.now();
    const report = await sendDue(firestoreStore(getFirestore()), fcmSender(getMessaging()), now);
    if (report.claimed > 0) logger.info('reminderWake', report);
    const { uid, id } = req.data;
    const snap = await getFirestore()
      .doc(`${paths.reminders(uid)}/${id}`)
      .get();
    const next = millis(snap.get('nextFireAt'));
    if (next !== undefined && next > now) {
      await wakeFor(cloudWakeQueue(), uid, id, undefined, next, now);
    }
  },
);
