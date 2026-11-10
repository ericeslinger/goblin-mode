// Put back (#154 step 1): the app asks for a run listed in What
// assistants changed to be undone. onCall, as everything the app asks
// the server to do is; the run must be the caller's own, since every
// path is under their uid. Reroute (#235, step 2) files what a put back
// of a filing took out under the project Eric picks, the same way.
// Both may carry the device's `timeZone`, which dates the line each
// leaves under Corrections in Context for Claude (#239); UTC without.
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { PutBackRefused, putBack, reroute } from './firestore';

/** The device's IANA zone, if it sent a plausible one. */
function zoneOf(data: unknown): string | undefined {
  const tz = (data as { timeZone?: unknown } | null)?.timeZone;
  return typeof tz === 'string' && tz.length <= 64 ? tz : undefined;
}

export const revertRun = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const runId = (request.data as { runId?: unknown } | null)?.runId;
  if (typeof runId !== 'string' || !runId) throw new HttpsError('invalid-argument', 'Which run?');
  try {
    const result = await putBack(
      getFirestore(),
      request.auth.uid,
      runId,
      Date.now(),
      zoneOf(request.data),
    );
    logger.info('revertRun', { runId, ...result });
    return result;
  } catch (err) {
    if (err instanceof PutBackRefused) throw new HttpsError(err.code, err.message);
    throw err;
  }
});

export const rerouteRun = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const data = request.data as { runId?: unknown; projectId?: unknown } | null;
  const runId = data?.runId;
  const projectId = data?.projectId;
  if (typeof runId !== 'string' || !runId)
    throw new HttpsError('invalid-argument', 'Which put back?');
  if (typeof projectId !== 'string' || !projectId)
    throw new HttpsError('invalid-argument', 'Which project?');
  try {
    const result = await reroute(
      getFirestore(),
      request.auth.uid,
      runId,
      projectId,
      Date.now(),
      zoneOf(request.data),
    );
    logger.info('rerouteRun', { runId, projectId, ...result });
    return result;
  } catch (err) {
    if (err instanceof PutBackRefused) throw new HttpsError(err.code, err.message);
    throw err;
  }
});
