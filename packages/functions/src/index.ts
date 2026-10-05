// Cloud Functions entry point. Everything exported here deploys.
// Emulator-only code (seeding, mirrors) must never be imported from this
// file; the deploy dry run fails if it reaches the bundle.
import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { healthBody } from './health';

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 5 });

/** Liveness check; the Worker proxies it at /api/health. */
export const health = onRequest((_req, res) => {
  res.json(healthBody(process.env['K_REVISION']));
});
