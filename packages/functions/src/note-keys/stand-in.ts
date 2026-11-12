// The production stand-in for the Worker's note key service: there is
// none. The emulator build (scripts/build-functions.mjs,
// MOSSGOBLIN_EMULATOR_BUILD) puts stand-in.emulator.ts in this module's
// place; the deploy dry run proves that one never reaches a production
// bundle.
import type { KeySource } from './client';

/** Never a key source here: production always asks the Worker. */
export function standInNoteKeys(_env: NodeJS.ProcessEnv): KeySource | undefined {
  return undefined;
}
