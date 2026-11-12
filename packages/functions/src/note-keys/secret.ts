// The functions' half of the note key service secret (note encryption
// step 2): the same value as the Worker's NOTE_KEYS_SERVICE, set once by
// hand (README, Run your own). Kept apart from client.ts on purpose.
// A function that lists this secret cannot deploy until it is set in
// Secret Manager (a non-interactive deploy stops on a missing secret),
// and merely loading this module declares it to the deploy. So nothing
// imports it yet; the step that first seals notes binds it to the
// functions that need keys, after the secret is set.
import { defineSecret } from 'firebase-functions/params';

/** Bind with `secrets: [NOTE_KEYS_SERVICE]`; `dataKeyFor` reads it from the environment. */
export const NOTE_KEYS_SERVICE = defineSecret('NOTE_KEYS_SERVICE');
