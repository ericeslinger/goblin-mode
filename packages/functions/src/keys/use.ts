// Using a gardener's key for one call (#144 step 2): opened for that
// call alone, never cached or logged. A provider that refuses the key
// marks it broken, which Settings shows; a use that works marks it used.
import { logger } from 'firebase-functions/v2';
import { type Provider, PROVIDER_INFO } from '@mossgoblin/schema';
import { type KeyDeps } from './core';

export interface KeyMarks {
  /** A call with the key worked: `lastUsedAt`. */
  markUsed(uid: string, provider: Provider): Promise<void>;
  /** The provider refused the key: `broken`, cleared by saving a new one. */
  markBroken(uid: string, provider: Provider): Promise<void>;
}

export type UseDeps = Pick<KeyDeps, 'store' | 'sealer'> & { marks: KeyMarks };

/** No key is kept for this provider; the message tells the gardener where to add one. */
export class NoKeyError extends Error {
  constructor(provider: Provider, purpose: string) {
    const name = PROVIDER_INFO[provider].name;
    super(
      `Add ${name === 'Gemini' ? 'a' : 'an'} ${name} key in Settings, AI assistants, to ${purpose}.`,
    );
  }
}

/** An HTTP status on an error, as the provider SDKs and fetch put it. */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** A mark is bookkeeping: its failure never changes what the call did. */
async function tryMark(what: string, mark: () => Promise<void>): Promise<void> {
  try {
    await mark();
  } catch (err) {
    logger.warn(`keys: could not mark ${what}`, {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Runs `use` with the gardener's key for `provider`. The key lives in
 * `use`'s argument for the call and nowhere else; an error from the
 * provider comes back as its message and status, never the request,
 * and never the key, should a library have put it in the message.
 */
export async function withKey<T>(
  deps: UseDeps,
  uid: string,
  provider: Provider,
  purpose: string,
  use: (key: string) => Promise<T>,
): Promise<T> {
  const ciphertext = await deps.store.ciphertext(uid, provider);
  if (ciphertext === undefined) throw new NoKeyError(provider, purpose);
  const key = await deps.sealer.open(uid, provider, ciphertext);
  let out: T;
  try {
    out = await use(key);
  } catch (err) {
    if (statusOf(err) === 401) {
      // Only this key: a new one saved during a long call is not the
      // one refused (review on #151). 403 is a key short of a model or
      // feature, not a bad key.
      await tryMark('broken', async () => {
        if ((await deps.store.ciphertext(uid, provider)) === ciphertext) {
          await deps.marks.markBroken(uid, provider);
        }
      });
      throw new Error(
        `${PROVIDER_INFO[provider].name} no longer accepts your key; replace it in Settings, ` +
          'AI assistants.',
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.split(key).join('[key]'));
  }
  await tryMark('used', () => deps.marks.markUsed(uid, provider));
  return out;
}
