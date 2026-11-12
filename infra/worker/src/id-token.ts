// Firebase ID tokens, checked in the Worker without the Admin SDK:
// the episode proxy (#180) and the note key route (note encryption
// step 2) both take the caller's token as a bearer token. Moved here
// from episode.ts (2026-11-12) when the second route came.

/** Where Google publishes the keys that sign Firebase ID tokens, as JWKs. */
export const GOOGLE_KEYS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
/** Slack allowed on a token's issue time, for a device clock a little ahead. */
const CLOCK_SKEW_S = 300;

/** Finds the public key a token names by `kid`, or undefined. */
export type KeyLookup = (kid: string) => Promise<CryptoKey | undefined>;

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

function base64url(part: string): Uint8Array {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function json(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64url(part)));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks a Firebase ID token as the Admin SDK does: RS256, signed by
 * the Google key its `kid` names, issued by and for this project, not
 * expired, issued and signed in before now, for a non-empty uid. The
 * uid, or undefined for any token that fails.
 */
export async function verifyIdToken(
  token: string,
  projectId: string,
  keys: KeyLookup,
  now: number = Date.now(),
): Promise<string | undefined> {
  const parts = token.split('.');
  if (parts.length !== 3 || !projectId) return undefined;
  const [head, body, sig] = parts;
  const header = json(head);
  const claims = json(body);
  if (!header || !claims) return undefined;
  if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') return undefined;
  const s = now / 1000;
  const { iss, aud, exp, iat, sub } = claims;
  const authTime = claims['auth_time'];
  if (iss !== `https://securetoken.google.com/${projectId}` || aud !== projectId) return undefined;
  if (typeof exp !== 'number' || exp <= s) return undefined;
  if (typeof iat !== 'number' || iat > s + CLOCK_SKEW_S) return undefined;
  if (authTime !== undefined && (typeof authTime !== 'number' || authTime > s + CLOCK_SKEW_S)) {
    return undefined;
  }
  if (typeof sub !== 'string' || !sub || sub.length > 128) return undefined;
  const key = await keys(header['kid']);
  if (!key) return undefined;
  let signature: Uint8Array;
  try {
    signature = base64url(sig);
  } catch {
    return undefined;
  }
  const ok = await crypto.subtle.verify(
    RS256,
    key,
    signature,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return ok ? sub : undefined;
}

/** Imports one of Google's JWKs for verifying RS256. */
export function importKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    RS256,
    false,
    ['verify'],
  );
}

/**
 * Google's signing keys, fetched when first needed and kept in memory
 * for as long as their `Cache-Control: max-age` says (an hour when it
 * says nothing). A `kid` not among them fetches again, at most once a
 * minute, since Google rotates keys ahead of using them.
 */
export function googleKeys(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  now: () => number = Date.now,
): KeyLookup {
  let held: { at: number; until: number; keys: Map<string, CryptoKey> } | undefined;
  let loading: Promise<void> | undefined;
  const load = async () => {
    const res = await fetchImpl(GOOGLE_KEYS_URL);
    if (!res.ok) throw new Error(`the token keys answered ${res.status}`);
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    const keys = new Map<string, CryptoKey>();
    for (const k of body.keys ?? []) {
      if (k.kid && k.kty === 'RSA' && k.n && k.e) keys.set(k.kid, await importKey(k));
    }
    const age = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1];
    const at = now();
    held = { at, until: at + (age ? Number(age) : 3600) * 1000, keys };
  };
  return async (kid) => {
    const t = now();
    const stale = !held || t >= held.until || (!held.keys.has(kid) && t - held.at > 60_000);
    if (stale) {
      loading ??= load().finally(() => (loading = undefined));
      try {
        await loading;
      } catch (err) {
        console.error('token keys not fetched', err);
        if (!held) return undefined;
      }
    }
    return held?.keys.get(kid);
  };
}

let shared: KeyLookup | undefined;

/** One `googleKeys` for the whole Worker isolate, so every route shares its cache. */
export function sharedGoogleKeys(): KeyLookup {
  return (shared ??= googleKeys());
}
