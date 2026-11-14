// EMULATOR_ONLY: a refusing recipe site and a scripted recipe reader
// for the emulator, which is off the network and has no Claude, so a
// journey can follow an import a site refused to a pasted page that
// makes the recipe (2026-11-14). Swapped in for stand-in.ts by the
// emulator build alone.
import { logger } from 'firebase-functions/v2';
import { type PageFetcher, answeredError, publicFetch } from '../attachments/import';
import type { RecipeExtractor } from './recipe-import';

const onEmulator = (env: NodeJS.ProcessEnv) =>
  env['FUNCTIONS_EMULATOR'] === 'true' && !!env['FIRESTORE_EMULATOR_HOST'];

/**
 * refused.invalid answers 402, as a site that licenses its pages does
 * to a cloud fetch; any other link is fetched as in production, so a
 * .invalid one fails as it always has.
 */
export function standInRecipePages(env: NodeJS.ProcessEnv): PageFetcher | undefined {
  if (!onEmulator(env)) return undefined;
  return async (url) => {
    if (new URL(url).hostname === 'refused.invalid') throw answeredError(402);
    return publicFetch(url);
  };
}

let said = false;

/**
 * Reads a recipe the plain way a journey writes one: its name the first
 * line, then the lines under "Ingredients", then those under "Method",
 * up to "Notes" if there is one. Anything else holds no recipe.
 */
export function standInRecipeReader(env: NodeJS.ProcessEnv): RecipeExtractor | undefined {
  if (!onEmulator(env)) return undefined;
  if (!said) {
    logger.warn('EMULATOR_ONLY: recipes are read by a scripted stand-in, not Claude');
    said = true;
  }
  return async ({ text }) => {
    const lines = text.split('\n').map((l) => l.trim());
    const at = (word: RegExp) => lines.findIndex((l) => word.test(l));
    const ing = at(/^ingredients$/i);
    const met = at(/^(?:method|instructions|directions)$/i);
    if (ing < 1 || met < ing) return undefined;
    const end = at(/^notes$/i);
    return {
      name: lines[0],
      ingredients: lines.slice(ing + 1, met).filter(Boolean),
      method: lines.slice(met + 1, end > met ? end : undefined).filter(Boolean),
    };
  };
}
