// EMULATOR_ONLY: the emulator build's stand-in for Cloud KMS, which has
// no emulator. scripts/build-functions.mjs swaps it in for stand-in.ts
// only when MOSSGOBLIN_EMULATOR_BUILD is set (scripts/emulators.sh,
// scripts/e2e.sh); the deploy dry run fails if this marker reaches the
// production bundle. Even here it seals only under the functions
// emulator, and says so once.
import { logger } from 'firebase-functions/v2';
import { localSealer } from './local-sealer';
import type { Sealer } from './sealer';

let said = false;

export function standInSealer(env: NodeJS.ProcessEnv): Sealer | undefined {
  if (env['FUNCTIONS_EMULATOR'] !== 'true' || !env['FIRESTORE_EMULATOR_HOST']) return undefined;
  if (!said) {
    // The marker in the message, not only this comment, since the bundle
    // keeps no comments: the dry run's grep must be able to find it.
    logger.warn('EMULATOR_ONLY: keys sealed with the emulator stand-in, not Cloud KMS');
    said = true;
  }
  return localSealer('mossgoblin-emulator');
}

/** The emulator is off the network: a key that looks right is taken. */
export const CHECK_SKIPPED = true;
