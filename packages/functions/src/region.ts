import { setGlobalOptions } from 'firebase-functions/v2';

/** Every function's region; the Worker's FUNCTIONS_ORIGIN must match. */
export const REGION = 'us-central1';

export function configureFunctions(): void {
  setGlobalOptions({ region: REGION, maxInstances: 5 });
}
