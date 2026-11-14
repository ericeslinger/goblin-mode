// The production stand-ins for the recipe importer's page fetcher and
// model: there are none. The emulator build (scripts/build-functions.mjs,
// MOSSGOBLIN_EMULATOR_BUILD) puts stand-in.emulator.ts in this module's
// place; the deploy dry run proves that one never reaches a production
// bundle.
import type { PageFetcher } from '../attachments/import';
import type { RecipeExtractor } from './recipe-import';

/** Never a stand-in here: production fetches the real page. */
export function standInRecipePages(_env: NodeJS.ProcessEnv): PageFetcher | undefined {
  return undefined;
}

/** Never a stand-in here either: production reads a page with Claude, or not at all. */
export function standInRecipeReader(_env: NodeJS.ProcessEnv): RecipeExtractor | undefined {
  return undefined;
}
