// Using a gardener's key for one call (#144 step 2): opened for that
// call alone, never cached or logged. A provider that refuses the key
// marks it broken, which Settings shows; a use that works marks it used.
import { type Provider, PROVIDER_INFO } from '@mossgoblin/schema';
import { type KeyDeps, openKey } from './core';

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

/**
 * Runs `use` with the gardener's key for `provider`. The key lives in
 * `use`'s argument for the call and nowhere else; an error from the
 * provider comes back as its message and status, never the request.
 */
export async function withKey<T>(
  deps: UseDeps,
  uid: string,
  provider: Provider,
  purpose: string,
  use: (key: string) => Promise<T>,
): Promise<T> {
  const key = await openKey(deps, uid, provider);
  if (key === undefined) throw new NoKeyError(provider, purpose);
  let out: T;
  try {
    out = await use(key);
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      await deps.marks.markBroken(uid, provider);
      throw new Error(
        `${PROVIDER_INFO[provider].name} no longer accepts your key; replace it in Settings, ` +
          'AI assistants.',
      );
    }
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  await deps.marks.markUsed(uid, provider);
  return out;
}
