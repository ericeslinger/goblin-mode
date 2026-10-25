// The production stand-in for the agent's model: there is none. The
// emulator build (scripts/build-functions.mjs, MOSSGOBLIN_EMULATOR_BUILD)
// puts stand-in.emulator.ts in this module's place; the deploy dry run
// proves that one never reaches a production bundle.
import type { AgentModel } from './model';

/** Never a model here: production always runs on the gardener's key. */
export function standInModel(_env: NodeJS.ProcessEnv): AgentModel | undefined {
  return undefined;
}
