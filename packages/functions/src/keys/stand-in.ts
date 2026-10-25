// The production stand-in for KMS: there is none. The emulator build
// (scripts/build-functions.mjs, MOSSGOBLIN_EMULATOR_BUILD) puts
// stand-in.emulator.ts in this module's place; the deploy dry run proves
// that one never reaches a production bundle.
import type { Sealer } from './sealer';

/** Never a sealer here: production always seals with KMS. */
export function standInSealer(_env: NodeJS.ProcessEnv): Sealer | undefined {
  return undefined;
}

/** Whether the provider check is skipped: never, in production. */
export const CHECK_SKIPPED = false;
