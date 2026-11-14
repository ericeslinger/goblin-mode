// Paste the page instead (2026-11-14): a site that will not let
// Mossgoblin read its pages can be opened in Eric's browser, copied and
// pasted into the recipe whose import it refused. A browser cannot
// fetch another site's page itself (CORS), so the app sends the paste
// here. onCall, as everything the app asks the server to do is; it
// writes nothing but the recipe the importer fills in, so no stored
// field carries the paste. Runs as the trigger does, as the account
// the Claude federation rule trusts.
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { NotesTools, ToolError } from '../mcp/tools';
import { recipeExtractor } from './reader';
import { MAX_PASTED_CHARS, readPastedRecipe } from './recipe-import';

export const importPastedRecipe = onCall(
  { serviceAccount: 'goblin-titles@', memory: '512MiB', timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    const data = request.data as { noteId?: unknown; text?: unknown } | null;
    const noteId = data?.noteId;
    const text = data?.text;
    if (typeof noteId !== 'string' || !noteId)
      throw new HttpsError('invalid-argument', 'Which recipe?');
    if (typeof text !== 'string') throw new HttpsError('invalid-argument', 'What page?');
    // Cut off before anything is claimed; the reader says the same.
    if (text.length > MAX_PASTED_CHARS) {
      throw new HttpsError('invalid-argument', 'The pasted page is over a million characters.');
    }
    try {
      const result = await new NotesTools(getFirestore(), request.auth.uid).finishPastedImport(
        noteId,
        (url) => readPastedRecipe(url, text, recipeExtractor()),
      );
      logger.info('importPastedRecipe', { noteId, state: result.state, chars: text.length });
      return result;
    } catch (err) {
      if (err instanceof ToolError) throw new HttpsError('failed-precondition', err.message);
      throw err;
    }
  },
);
