// Put back (#154 step 1): the app asks for a run listed in What
// assistants changed to be undone. onCall, as everything the app asks
// the server to do is; the run must be the caller's own, since every
// path is under their uid.
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { PutBackRefused, putBack } from './firestore';

export const revertRun = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const runId = (request.data as { runId?: unknown } | null)?.runId;
  if (typeof runId !== 'string' || !runId) throw new HttpsError('invalid-argument', 'Which run?');
  try {
    const result = await putBack(getFirestore(), request.auth.uid, runId);
    logger.info('revertRun', { runId, ...result });
    return result;
  } catch (err) {
    if (err instanceof PutBackRefused) throw new HttpsError(err.code, err.message);
    throw err;
  }
});
