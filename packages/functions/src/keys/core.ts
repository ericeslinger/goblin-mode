// Saving and removing a gardener's provider key (#144), pure over a
// store and a sealer. The key is checked for shape, checked with the
// provider, sealed, and kept server-only; the app gets back only the
// masked record. Nothing here ever returns a key.
import { type Provider, keyLooksRight, maskKey, PROVIDER_INFO } from '@mossgoblin/schema';
import { type KeyCheck } from './providers';
import { type Sealer } from './sealer';

export interface KeyStore {
  /** Writes the ciphertext and the masked record together. */
  put(uid: string, provider: Provider, ciphertext: string, masked: string): Promise<void>;
  /** Removes both; nothing to remove is fine. */
  drop(uid: string, provider: Provider): Promise<void>;
  /** The ciphertext kept, if any. */
  ciphertext(uid: string, provider: Provider): Promise<string | undefined>;
}

/** An error the gardener can act on; `code` as HttpsError names them. */
export class KeyError extends Error {
  constructor(
    readonly code: 'invalid-argument' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export interface KeyDeps {
  store: KeyStore;
  sealer: Sealer;
  check(provider: Provider, key: string): Promise<KeyCheck>;
}

/** Keeps a key the gardener pasted; returns what the app may show. */
export async function saveKey(
  deps: KeyDeps,
  uid: string,
  provider: Provider,
  raw: string,
): Promise<{ masked: string }> {
  const key = raw.trim();
  const info = PROVIDER_INFO[provider];
  if (!keyLooksRight(provider, key)) {
    throw new KeyError(
      'invalid-argument',
      `That does not look like ${info.name === 'Gemini' ? 'a' : 'an'} ${info.name} key: ` +
        `one starts with ${info.prefix}.`,
    );
  }
  const check = await deps.check(provider, key);
  if (check === 'rejected') {
    throw new KeyError('invalid-argument', `${info.name} did not accept this key.`);
  }
  if (check === 'unreachable') {
    throw new KeyError('unavailable', `Could not reach ${info.name} to check the key; try again.`);
  }
  const masked = maskKey(provider, key);
  await deps.store.put(uid, provider, await deps.sealer.seal(uid, provider, key), masked);
  return { masked };
}

/** Drops a key; the gardener is told to revoke it at the provider too. */
export async function removeKey(deps: KeyDeps, uid: string, provider: Provider): Promise<void> {
  await deps.store.drop(uid, provider);
}

/**
 * The gardener's key for a feature to use, opened for this call only:
 * never cached, never logged. Undefined when none is kept.
 */
export async function openKey(
  deps: Pick<KeyDeps, 'store' | 'sealer'>,
  uid: string,
  provider: Provider,
): Promise<string | undefined> {
  const ciphertext = await deps.store.ciphertext(uid, provider);
  return ciphertext === undefined ? undefined : deps.sealer.open(uid, provider, ciphertext);
}
