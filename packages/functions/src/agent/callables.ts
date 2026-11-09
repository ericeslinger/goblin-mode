// Do it now (#144 step 3): the app asks for a sent note to be done at
// once. onCall, as everything the app asks the server to do is; it only
// writes the run, which the agentRun trigger then drives as the account
// that may open keys. Returns before the run, which can take minutes.
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { requestRun } from './request';

export const startRun = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = request.auth.uid;
  const noteId = (request.data as { noteId?: unknown } | null)?.noteId;
  if (typeof noteId !== 'string' || !noteId)
    throw new HttpsError('invalid-argument', 'Which note?');
  return { runId: await requestRun(getFirestore(), uid, noteId, 'now') };
});
