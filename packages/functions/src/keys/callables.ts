// The app's calls for a gardener's provider keys (#144): onCall, as
// everything the app asks the server to do is (Eric, 2026-10-25). Both
// run as goblin-keys, the account that may encrypt with the KMS key and
// nothing else: no function that saves keys can open them.
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { Provider } from '@mossgoblin/schema';
import { KeyError, removeKey as drop, saveKey as save } from './core';
import { firestoreKeyStore } from './firestore-store';
import { checkKey } from './providers';
import { sealerFromEnv } from './sealer';
import { CHECK_SKIPPED } from './stand-in';

/** The account that encrypts; the deploy's IAM gives it that role alone. */
const KEYS_ACCOUNT = 'goblin-keys@';

function deps() {
  return {
    store: firestoreKeyStore(getFirestore()),
    sealer: sealerFromEnv(process.env),
    check: CHECK_SKIPPED
      ? async () => 'ok' as const
      : (provider: Provider, key: string) => checkKey(provider, key, fetch),
  };
}

function uidOf(auth: { uid: string } | undefined): string {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  return auth.uid;
}

function providerOf(data: unknown): Provider {
  const parsed = Provider.safeParse((data as { provider?: unknown } | null)?.provider);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Unknown provider.');
  return parsed.data;
}

/** Never the error object: an HTTP library's may carry the key in a header. */
function fail(what: string, err: unknown): never {
  if (err instanceof KeyError) throw new HttpsError(err.code, err.message);
  logger.error(what, { message: err instanceof Error ? err.message : String(err) });
  throw new HttpsError('internal', `Could not ${what}.`);
}

/** Keeps a pasted key, checked with its provider; answers with the masked record. */
export const saveKey = onCall({ serviceAccount: KEYS_ACCOUNT }, async (request) => {
  const uid = uidOf(request.auth);
  const provider = providerOf(request.data);
  const key = (request.data as { key?: unknown }).key;
  if (typeof key !== 'string' || !key.trim()) {
    throw new HttpsError('invalid-argument', 'Paste a key first.');
  }
  try {
    return await save(deps(), uid, provider, key);
  } catch (err) {
    fail('save the key', err);
  }
});

/** Drops a key; the app reminds the gardener to revoke it at the provider. */
export const removeKey = onCall({ serviceAccount: KEYS_ACCOUNT }, async (request) => {
  const uid = uidOf(request.auth);
  const provider = providerOf(request.data);
  try {
    await drop(deps(), uid, provider);
    return { removed: true };
  } catch (err) {
    fail('remove the key', err);
  }
});
