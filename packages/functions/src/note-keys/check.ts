// The check before sealing is switched on (note encryption, the
// gardener's switch, 2026-11-15; DESIGN.md, "Note encryption"). The app
// sends a fresh nonce; the functions fetch the gardener's key through
// their normal path, afresh (`freshDataKeyFor`: an identity token for
// this function's account, the Worker's `/api/note-key/for`, past the
// instance's kept key, so a pass means the Worker answers now) and answer a
// proof of it (`keyCheckProof`), never the key. The app computes the
// same proof with the key it got from `/api/note-key` and compares, so
// both sides are shown to hold one key before anything is sealed.
//
// One callable for each account the functions that read notes run as,
// the three on the Worker's `NOTE_KEY_CALLERS`, all with the same
// handler (`keyCheckCallable`): `checkNoteKey` as the default compute
// account (`mcp`, `noteHistory`, `proposalAccepted`, put back),
// `checkNoteKeyTitles` as `goblin-titles` (`noteTitle`, the recipe
// importers) and `checkNoteKeyRunner` as `goblin-runner` (agent runs,
// transcriptions). The app asks all three and turns sealing on only
// when every proof matches, so no part of the server is left unable to
// open a sealed note.
import { isKeyCheckNonce, keyCheckProof, NOTE_KEY_VERSION, type DataKey } from '@mossgoblin/schema';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { NoteKeyServiceError, NoteKeysUnconfigured, freshDataKeyFor } from './client';

/** What the app is answered: the key's version and the proof, never the key. */
export interface KeyCheckAnswer {
  v: number;
  proof: string;
}

/** Why the functions could not show the key, in words the app can show. */
export class KeyCheckRefused extends Error {
  override readonly name = 'KeyCheckRefused';
  constructor(
    readonly code: 'invalid-argument' | 'failed-precondition' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The proof for gardener `uid` and `nonce`, the key fetched as every
 * function fetches it. Refuses a nonce of the wrong shape, and says
 * which way fetching the key failed; never the key, a token or the uid.
 */
export async function keyCheck(
  uid: string,
  nonce: unknown,
  keyFor: (uid: string) => Promise<DataKey> = freshDataKeyFor,
): Promise<KeyCheckAnswer> {
  if (!isKeyCheckNonce(nonce)) throw new KeyCheckRefused('invalid-argument', 'Which check?');
  let key: DataKey;
  try {
    key = await keyFor(uid);
  } catch (err) {
    const why = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown';
    logger.warn('checkNoteKey: the functions could not get the note key', { why });
    if (err instanceof NoteKeysUnconfigured) {
      throw new KeyCheckRefused(
        'failed-precondition',
        'The server is not set up to ask for note keys.',
      );
    }
    if (err instanceof NoteKeyServiceError) {
      throw new KeyCheckRefused(
        'unavailable',
        `The key service did not give the server its key${err.status ? ` (${err.status})` : ''}.`,
      );
    }
    throw new KeyCheckRefused('unavailable', 'The server could not get its key.');
  }
  return { v: NOTE_KEY_VERSION, proof: keyCheckProof(key, uid, nonce) };
}

/**
 * The check as a callable run as `serviceAccount` (the default compute
 * account when none): signed in only, for the caller's own key.
 */
export function keyCheckCallable(serviceAccount?: string) {
  return onCall(serviceAccount ? { serviceAccount } : {}, async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    const nonce = (request.data as { nonce?: unknown } | null)?.nonce;
    try {
      return await keyCheck(request.auth.uid, nonce);
    } catch (err) {
      if (err instanceof KeyCheckRefused) throw new HttpsError(err.code, err.message);
      throw err;
    }
  });
}

/** As the default compute account: MCP, History and merges, suggestions, put back. */
export const checkNoteKey = keyCheckCallable();
/** As `goblin-titles`: titles and the recipe importers. */
export const checkNoteKeyTitles = keyCheckCallable('goblin-titles@');
/** As `goblin-runner`: the assistant's runs and transcriptions. */
export const checkNoteKeyRunner = keyCheckCallable('goblin-runner@');
