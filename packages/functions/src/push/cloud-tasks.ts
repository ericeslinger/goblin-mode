import { getFunctions } from 'firebase-admin/functions';
import { REGION } from '../region';
import type { WakeQueue } from './wake';

/** The task queue function that wakes sendDue (see reminder-wake.ts). */
export const WAKE_FUNCTION = 'reminderWake';

/** The WakeQueue over Cloud Tasks, as the admin SDK. */
export function cloudWakeQueue(): WakeQueue {
  return {
    async enqueue(uid, id, at, name) {
      // The e2e suite runs no tasks emulator: a dispatched task would
      // claim reminders mid-journey and push to fake tokens.
      if (process.env['FUNCTIONS_EMULATOR'] === 'true') return;
      try {
        await getFunctions()
          .taskQueue(`locations/${REGION}/functions/${WAKE_FUNCTION}`)
          .enqueue({ uid, id }, { scheduleTime: new Date(at), id: name });
      } catch (err) {
        if ((err as { code?: string }).code === 'functions/task-already-exists') return;
        throw err;
      }
    },
  };
}
