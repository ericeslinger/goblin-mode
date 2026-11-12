// EMULATOR_ONLY: the emulator build's stand-in for the Worker's note
// key service, which does not run on localhost. scripts/build-functions.mjs
// swaps it in for stand-in.ts only when MOSSGOBLIN_EMULATOR_BUILD is set
// (scripts/emulators.sh, scripts/e2e.sh); the deploy dry run fails if
// this marker reaches the production bundle. Even here it answers only
// under the functions emulator, with the fixed development master and
// the Worker's own derivation, and says so once.
import { NOTE_KEY_VERSION, deriveNoteKey, masterFromBase64 } from '@mossgoblin/schema';
import { logger } from 'firebase-functions/v2';
import type { KeySource } from './client';
import { DEV_NOTE_KEYS_MASTER } from './dev-master.emulator';

let said = false;

export function standInNoteKeys(env: NodeJS.ProcessEnv): KeySource | undefined {
  if (env['FUNCTIONS_EMULATOR'] !== 'true' || !env['FIRESTORE_EMULATOR_HOST']) return undefined;
  const master = masterFromBase64(DEV_NOTE_KEYS_MASTER)!;
  return async (uid) => {
    if (!said) {
      // The marker in the message, not only this comment, since the
      // bundle keeps no comments: the dry run's grep must find it.
      logger.warn('EMULATOR_ONLY: note keys derived from the development master, not the Worker');
      said = true;
    }
    return deriveNoteKey(master, uid, NOTE_KEY_VERSION);
  };
}
