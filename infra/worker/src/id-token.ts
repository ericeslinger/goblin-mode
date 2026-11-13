// Google-signed tokens, checked in the Worker without the Admin SDK.
// Firebase ID tokens: the episode proxy (#180) and the app's note key
// route (note encryption step 2) take the caller's as a bearer token.
// Moved here from episode.ts (2026-11-12) when the second route came.
// Google OIDC identity tokens: the functions' note key route takes
// one minted for the functions' own service account (2026-11-13).
// The two are signed with different key sets, so a token of one kind
// never passes the other's check.

/** Where Google publishes the keys that sign Firebase ID tokens, as JWKs. */
export const GOOGLE_KEYS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
/** Where Google publishes the keys that sign its OIDC identity tokens, as JWKs. */
export const GOOGLE_OIDC_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** The issuers Google's OIDC identity tokens carry; both spellings are in use. */
export const GOOGLE_OIDC_ISSUERS: readonly string[] = [
  'https://accounts.google.com',
  'accounts.google.com',
];
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

/** A token split and decoded, its signature not yet checked. */
interface Decoded {
  signed: string;
  sig: string;
  kid: string;
  claims: Record<string, unknown>;
}

/** The parts of an RS256 JWT with a `kid`, or undefined for anything else. */
function decode(token: string): Decoded | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [head, body, sig] = parts;
  const header = json(head);
  const claims = json(body);
  if (!header || !claims) return undefined;
  if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') return undefined;
  return { signed: `${head}.${body}`, sig, kid: header['kid'], claims };
}

/** Whether the key `kid` names, in this key set, signed the token. */
async function signedBy(token: Decoded, keys: KeyLookup): Promise<boolean> {
  const key = await keys(token.kid);
  if (!key) return false;
  let signature: Uint8Array;
  try {
    signature = base64url(token.sig);
  } catch {
    return false;
  }
  return crypto.subtle.verify(RS256, key, signature, new TextEncoder().encode(token.signed));
}

/** Whether `exp` is a number after now and `iat` one not ahead of it beyond the skew. */
function current(claims: Record<string, unknown>, s: number): boolean {
  const { exp, iat } = claims;
  if (typeof exp !== 'number' || exp <= s) return false;
  return typeof iat === 'number' && iat <= s + CLOCK_SKEW_S;
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
  if (!projectId) return undefined;
  const decoded = decode(token);
  if (!decoded) return undefined;
  const { claims } = decoded;
  const s = now / 1000;
  const { iss, aud, sub } = claims;
  const authTime = claims['auth_time'];
  if (iss !== `https://securetoken.google.com/${projectId}` || aud !== projectId) return undefined;
  if (!current(claims, s)) return undefined;
  if (authTime !== undefined && (typeof authTime !== 'number' || authTime > s + CLOCK_SKEW_S)) {
    return undefined;
  }
  if (typeof sub !== 'string' || !sub || sub.length > 128) return undefined;
  return (await signedBy(decoded, keys)) ? sub : undefined;
}

/** The longest identity token lifetime accepted: Google mints them for an hour. */
const MAX_OIDC_LIFETIME_S = 3600 + CLOCK_SKEW_S;

/**
 * Checks a Google OIDC identity token, as the metadata server mints
 * for a service account: RS256, signed by the Google OIDC key its
 * `kid` names (`keys` must look in GOOGLE_OIDC_KEYS_URL's set, never
 * the Firebase one), issued by Google, for exactly `audience`, not
 * expired, issued before now and for no more than an hour, with an
 * `email` Google has verified. The email, lower-cased, or undefined
 * for any token that fails. The caller decides whether that email may
 * ask.
 */
export async function verifyGoogleIdentity(
  token: string,
  audience: string,
  keys: KeyLookup,
  now: number = Date.now(),
): Promise<string | undefined> {
  if (!audience) return undefined;
  const decoded = decode(token);
  if (!decoded) return undefined;
  const { claims } = decoded;
  const s = now / 1000;
  const { iss, aud, exp, iat, email } = claims;
  if (typeof iss !== 'string' || !GOOGLE_OIDC_ISSUERS.includes(iss)) return undefined;
  if (aud !== audience) return undefined;
  if (!current(claims, s)) return undefined;
  if ((exp as number) - (iat as number) > MAX_OIDC_LIFETIME_S) return undefined;
  if (claims['email_verified'] !== true) return undefined;
  if (typeof email !== 'string' || !email || email.length > 254) return undefined;
  return (await signedBy(decoded, keys)) ? email.toLowerCase() : undefined;
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
 * One of Google's key sets (`url`, the Firebase one unless named),
 * fetched when first needed and kept in memory
 * for as long as their `Cache-Control: max-age` says (an hour when it
 * says nothing). A `kid` not among them fetches again, at most once a
 * minute, since Google rotates keys ahead of using them.
 */
export function googleKeys(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  now: () => number = Date.now,
  url: string = GOOGLE_KEYS_URL,
): KeyLookup {
  let held: { at: number; until: number; keys: Map<string, CryptoKey> } | undefined;
  let loading: Promise<void> | undefined;
  const load = async () => {
    const res = await fetchImpl(url);
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

const shared = new Map<string, KeyLookup>();

/**
 * One `googleKeys` per key set for the whole Worker isolate, so every
 * route that checks the same kind of token shares its cache, and no
 * key set's keys are ever looked up for another.
 */
export function sharedGoogleKeys(url: string = GOOGLE_KEYS_URL): KeyLookup {
  let keys = shared.get(url);
  if (!keys) shared.set(url, (keys = googleKeys(undefined, undefined, url)));
  return keys;
}
