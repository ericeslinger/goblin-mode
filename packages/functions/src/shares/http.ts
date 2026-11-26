import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { answerShare } from './page';

/**
 * A note's public page (2026-11-26; page.ts), proxied by the Worker at
 * `/s/*` on the app's domain. No sign-in: the link is the key. Small
 * and short: a share's body is at most 200,000 characters, which
 * renders in well under a second.
 */
export const publicShare = onRequest(
  { memory: '256MiB', timeoutSeconds: 30, concurrency: 20 },
  async (req, res) => {
    const db = getFirestore();
    const answer = await answerShare(
      req.method,
      req.path,
      async (id) => {
        const snap = await db.doc(`shares/${id}`).get();
        return snap.exists ? snap.data() : undefined;
      },
      process.env['OWNER_UID'] || undefined,
    );
    if (answer.status === 503) logger.warn('publicShare: could not read a share');
    res.status(answer.status).set(answer.headers);
    if (answer.body === null) res.end();
    else res.send(answer.body);
  },
);
