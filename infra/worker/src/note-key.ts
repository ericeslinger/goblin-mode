// The note key service (note encryption step 2; Eric, 2026-11-12,
// DESIGN.md "Note encryption", Key custody): the Worker keeps each
// gardener's data key in Cloudflare's custody, apart from the notes in
// Google's. It stores no keys. It holds one master secret,
// NOTE_KEYS_MASTER, set once by hand with `wrangler secret put`, and
// derives a gardener's key from it on each ask (packages/schema
// note-key.ts, shared with the emulator stand-ins so they cannot drift).
//
// Two routes, and who may ask what:
// - `POST /api/note-key`, for the app: the caller's Firebase ID token as
//   a bearer token, answered with that token's own uid's key and no
//   other. The uid comes from the verified token alone.
// - `POST /api/note-key/for`, for the functions: any gardener's key,
//   by uid in the body, to a caller presenting a Google-signed OIDC
//   identity token for this route's own URL, minted for one of the
//   service accounts in NOTE_KEY_CALLERS (2026-11-13; it replaced a
//   shared service secret, DESIGN.md, Key custody).
// Without the master both answer 503, and the app carries on without
// a key; the functions' route also answers 503 without APP_DOMAIN or
// an allowlist. Neither answers another origin: no CORS, and a request a
// browser marks as cross-site or same-site is refused, as /share does.

import {
  NOTE_KEY_VERSION,
  bytesToBase64,
  deriveNoteKey,
  masterFromBase64,
} from '../../../packages/schema/src/note-key';
import {
  GOOGLE_OIDC_KEYS_URL,
  type KeyLookup,
  sharedGoogleKeys,
  verifyGoogleIdentity,
  verifyIdToken,
} from './id-token';

/** What the note key routes need from the Worker's bindings. */
export interface NoteKeyEnv {
  /** The Firebase project whose ID tokens are accepted (scripts/deploy.sh). */
  FIREBASE_PROJECT_ID?: string;
  /** Base64 of 32 random bytes; a Worker secret set by hand (README, Run your own). */
  NOTE_KEYS_MASTER?: string;
  /** The domain this Worker serves (scripts/deploy.sh); fixes the functions' audience. */
  APP_DOMAIN?: string;
  /**
   * The service accounts that may ask for any gardener's key, by
   * email, separated by commas or spaces: a Worker var, not a secret,
   * passed by scripts/deploy.sh.
   */
  NOTE_KEY_CALLERS?: string;
}

/** The app route, and the functions' route under it. */
export const NOTE_KEY_PATH = '/api/note-key';
export const NOTE_KEY_FOR_PATH = '/api/note-key/for';

/** The largest body the functions' route reads, in bytes. */
const MAX_BODY = 1024;
/** The longest uid Firebase Auth makes. */
const MAX_UID = 128;

/** What a route checks tokens with, as a seam for specs. */
export interface NoteKeyDeps {
  keys: KeyLookup;
  now?: number;
}

const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

function plain(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...HEADERS, ...headers },
  });
}

async function keyResponse(master: Uint8Array, uid: string): Promise<Response> {
  const key = await deriveNoteKey(master, uid, NOTE_KEY_VERSION);
  return new Response(JSON.stringify({ v: NOTE_KEY_VERSION, key: bytesToBase64(key) }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...HEADERS },
  });
}

/** A request a browser says came from another site (Sec-Fetch-Site). */
function fromAnotherSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  return site === 'cross-site' || site === 'same-site';
}

function bearerOf(request: Request): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
}

/**
 * `POST /api/note-key`: the signed-in gardener's own data key, `{ v,
 * key }`, for the token in `Authorization: Bearer`. Any account of the
 * project gets its own key; no account gets another's.
 */
export async function appNoteKey(
  request: Request,
  env: NoteKeyEnv,
  deps: NoteKeyDeps = { keys: sharedGoogleKeys() },
): Promise<Response> {
  if (request.method !== 'POST') return plain(405, 'POST only', { allow: 'POST' });
  if (fromAnotherSite(request)) return plain(403, 'not from another site');
  const master = masterFromBase64(env.NOTE_KEYS_MASTER);
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!master || !projectId) return plain(503, 'note keys are not configured');
  const bearer = bearerOf(request);
  const uid = bearer ? await verifyIdToken(bearer, projectId, deps.keys, deps.now) : undefined;
  if (!uid) return plain(401, 'sign in first', { 'www-authenticate': 'Bearer' });
  return keyResponse(master, uid);
}

/** A bare host name, with a port at most: what APP_DOMAIN must be. */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

/**
 * The audience a functions' token must name: this route's full URL on
 * the configured app domain, the same string the functions build from
 * their own APP_DOMAIN. Taken from configuration, never from the
 * request, so no Host header or other request detail can change what
 * is expected. Undefined when APP_DOMAIN is missing or not a domain.
 */
export function serviceAudience(env: NoteKeyEnv): string | undefined {
  const domain = env.APP_DOMAIN?.trim().toLowerCase() ?? '';
  return DOMAIN.test(domain) ? `https://${domain}${NOTE_KEY_FOR_PATH}` : undefined;
}

/** NOTE_KEY_CALLERS as a set of exact, lower-cased emails; empty when unset. */
export function noteKeyCallers(env: NoteKeyEnv): Set<string> {
  return new Set(
    (env.NOTE_KEY_CALLERS ?? '')
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)),
  );
}

/**
 * `POST /api/note-key/for`: any gardener's data key, `{ v, key }`, for
 * `{ "uid": … }` in the body, to the functions alone: a Google OIDC
 * identity token in `Authorization: Bearer`, for this route's URL as
 * its audience, whose verified email is in NOTE_KEY_CALLERS (401 for
 * a token that fails, 403 for a good one from another account). With no
 * master, app domain or allowlist it refuses every caller.
 */
export async function serviceNoteKey(
  request: Request,
  env: NoteKeyEnv,
  deps: NoteKeyDeps = { keys: sharedGoogleKeys(GOOGLE_OIDC_KEYS_URL) },
): Promise<Response> {
  if (request.method !== 'POST') return plain(405, 'POST only', { allow: 'POST' });
  if (fromAnotherSite(request)) return plain(403, 'not from another site');
  const master = masterFromBase64(env.NOTE_KEYS_MASTER);
  const audience = serviceAudience(env);
  const callers = noteKeyCallers(env);
  if (!master || !audience || callers.size === 0) {
    return plain(503, 'note keys are not configured');
  }
  const bearer = bearerOf(request);
  const email = bearer
    ? await verifyGoogleIdentity(bearer, audience, deps.keys, deps.now)
    : undefined;
  if (!email) return plain(401, 'not the service', { 'www-authenticate': 'Bearer' });
  // A token Google signed for another account: asking again with a
  // fresh one would not help, so not a 401.
  if (!callers.has(email)) return plain(403, 'not a caller of this service');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) {
    return plain(413, 'too large');
  }
  let uid: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return plain(413, 'too large');
    uid = (JSON.parse(text) as { uid?: unknown } | null)?.uid;
  } catch {
    return plain(400, 'a JSON body with a uid');
  }
  if (typeof uid !== 'string' || !uid || uid.length > MAX_UID) return plain(400, 'no uid');
  return keyResponse(master, uid);
}
