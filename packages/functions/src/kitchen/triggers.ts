import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { publicFetch } from '../attachments/import';
import { NotesTools } from '../mcp/tools';
import { federationFromEnv } from '../notes/claude-titler';
import { claudeRecipeReader } from './claude-recipe-reader';
import { type RecipeExtractor, readRecipe } from './recipe-import';

let extractor: RecipeExtractor | null | undefined;

/**
 * A recipe the app asked to import (#128): read its page and fill it
 * in. Runs as the service account the Claude federation rule trusts,
 * for the pages without recipe data that Claude reads.
 */
export const recipeImport = onDocumentWritten(
  {
    document: 'users/{uid}/notes/{noteId}',
    serviceAccount: 'goblin-titles@',
    memory: '512MiB',
    // A fetch (15 s a hop) and two tries of Claude (90 s each) fit inside.
    timeoutSeconds: 300,
  },
  async (event) => {
    const after = event.data?.after.data();
    if (after?.['kind'] !== 'recipe' || after['importState'] !== 'requested') return;
    if (extractor === undefined) {
      const config = federationFromEnv(process.env);
      extractor = config ? claudeRecipeReader(config) : null;
    }
    const { uid, noteId } = event.params;
    const outcome = await new NotesTools(getFirestore(), uid).finishRecipeImport(noteId, (url) =>
      readRecipe(url, publicFetch, extractor ?? null),
    );
    logger.info('recipeImport', { noteId, outcome });
  },
);
