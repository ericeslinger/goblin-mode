import { Habit } from '@mossgoblin/schema';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { NUDGE_WAKE_FUNCTION, cloudWakeQueue } from './cloud-tasks';
import { fcmSender } from './fcm-sender';
import { firestoreNudgeStore } from './habit-nudge-store';
import { sendNudges, wakeForNudge, wakeUpcomingNudges } from './habit-nudges';

// Habit nudges (step 4 of #324, 2026-11-21), woken as reminders are
// (DESIGN.md, Push, Waking): a habit's write queues a Cloud Task for its
// next nudge, the task runs sendNudges, and an hourly run sends what a
// task missed and queues the next hour's wakes. The claim on the day
// makes any run safe.

const queue = () => cloudWakeQueue(NUDGE_WAKE_FUNCTION);

/** Hourly: the nudges a task missed, then wakes for the next hour's. */
export const habitNudgePush = onSchedule(
  // No retries: a retried run could only resend what the claim stopped.
  { schedule: 'every 60 minutes', timeZone: 'UTC', retryCount: 0 },
  async () => {
    const now = Date.now();
    const db = firestoreNudgeStore(getFirestore());
    // One query of the nudging habits serves both halves.
    const habits = await db.nudging();
    const store = { ...db, nudging: async () => habits };
    const report = await sendNudges(store, fcmSender(getMessaging()), now);
    if (report.pushed > 0) logger.info('habitNudgePush', report);
    await wakeUpcomingNudges(store, queue(), now, habits);
  },
);

/**
 * A habit written: queue a wake for its next nudge, if it has one. The
 * module's quiet hours are read only for a habit that nudges.
 */
export const habitNudgeScheduled = onDocumentWritten(
  'users/{uid}/habits/{habitId}',
  async (event) => {
    const { uid, habitId } = event.params;
    const after = event.data?.after;
    if (!after?.exists || after.get('nudge') !== true) return;
    const parsed = Habit.safeParse(after.data());
    if (!parsed.success) return;
    const store = firestoreNudgeStore(getFirestore());
    const module = await store.module(uid);
    if (!module.on) return;
    await wakeForNudge(
      queue(),
      { uid, id: habitId, habit: parsed.data },
      module.config,
      Date.now(),
    );
  },
);

/** A wake: send whatever nudges are due (the claim stops a double send). */
export const habitNudgeWake = onTaskDispatched<{ uid: string; id: string }>(
  { retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 } },
  async () => {
    const report = await sendNudges(
      firestoreNudgeStore(getFirestore()),
      fcmSender(getMessaging()),
      Date.now(),
    );
    if (report.pushed > 0) logger.info('habitNudgeWake', report);
  },
);
