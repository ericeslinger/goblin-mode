import { onRequest } from 'firebase-functions/v2/https';
import { FRESH_NOTE_AFTER_MS } from '@goblin/schema';

/** The liveness body; `revision` is Cloud Run's K_REVISION when deployed. */
export function healthBody(revision: string | undefined) {
  // Referencing schema code keeps the bundle honest about workspace imports.
  return { ok: true, revision: revision ?? 'local', freshNoteAfterMs: FRESH_NOTE_AFTER_MS };
}

/** Liveness check; the Worker proxies it at /api/health. */
export const health = onRequest((_req, res) => {
  res.json(healthBody(process.env['K_REVISION']));
});
