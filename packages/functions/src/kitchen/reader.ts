// What the recipe importer reads with (#128), for the trigger and the
// pasted-page callable alike: the public fetcher, and Claude when this
// deployment is federated with it, or the emulator's stand-ins.
import { type PageFetcher, publicFetch } from '../attachments/import';
import { federationFromEnv } from '../notes/claude-titler';
import { claudeRecipeReader } from './claude-recipe-reader';
import type { RecipeExtractor } from './recipe-import';
import { standInRecipePages, standInRecipeReader } from './stand-in';

let extractor: RecipeExtractor | null | undefined;

/** Fetches a recipe's page. */
export function recipePages(): PageFetcher {
  return standInRecipePages(process.env) ?? publicFetch;
}

/** Reads a page without recipe data, or null when nothing here can. */
export function recipeExtractor(): RecipeExtractor | null {
  if (extractor === undefined) {
    const config = federationFromEnv(process.env);
    extractor = standInRecipeReader(process.env) ?? (config ? claudeRecipeReader(config) : null);
  }
  return extractor;
}
