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
//   by uid in the body, to a caller holding the service secret
//   NOTE_KEYS_SERVICE (the same value as the functions' secret).
// Without the master both answer 503, and the app carries on without
// a key. Neither answers another origin: no CORS, and a request a
// browser marks as cross-site or same-site is refused, as /share does.

import {
  NOTE_KEY_VERSION,
  bytesToBase64,
  deriveNoteKey,
  masterFromBase64,
} from '../../../packages/schema/src/note-key';
import { type KeyLookup, sharedGoogleKeys, verifyIdToken } from './id-token';

/** What the note key routes need from the Worker's bindings. */
export interface NoteKeyEnv {
  /** The Firebase project whose ID tokens are accepted (scripts/deploy.sh). */
  FIREBASE_PROJECT_ID?: string;
  /** Base64 of 32 random bytes; a Worker secret set by hand (README, Run your own). */
  NOTE_KEYS_MASTER?: string;
  /** What the functions present to ask for a key; a Worker secret set by hand. */
  NOTE_KEYS_SERVICE?: string;
}

/** The app route, and the functions' route under it. */
export const NOTE_KEY_PATH = '/api/note-key';
export const NOTE_KEY_FOR_PATH = '/api/note-key/for';

/** A service secret shorter than this is treated as not set. */
export const MIN_SERVICE_SECRET = 32;
/** The largest body the functions' route reads, in bytes. */
const MAX_BODY = 1024;
/** The longest uid Firebase Auth makes. */
const MAX_UID = 128;

/** What the app route checks tokens with, as a seam for specs. */
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

/**
 * `POST /api/note-key/for`: any gardener's data key, `{ v, key }`, for
 * `{ "uid": … }` in the body, to the functions alone: the service
 * secret in `Authorization: Bearer`, compared in constant time. With
 * no service secret set (or one too short to be one) it refuses every
 * caller.
 */
export async function serviceNoteKey(request: Request, env: NoteKeyEnv): Promise<Response> {
  if (request.method !== 'POST') return plain(405, 'POST only', { allow: 'POST' });
  if (fromAnotherSite(request)) return plain(403, 'not from another site');
  const master = masterFromBase64(env.NOTE_KEYS_MASTER);
  const expected = env.NOTE_KEYS_SERVICE?.trim() ?? '';
  if (!master || expected.length < MIN_SERVICE_SECRET) {
    return plain(503, 'note keys are not configured');
  }
  const presented = bearerOf(request);
  if (!presented || !(await sameSecret(presented, expected))) {
    return plain(401, 'not the service', { 'www-authenticate': 'Bearer' });
  }
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

/**
 * Whether two secrets are equal, in time that depends on neither: each
 * is hashed with SHA-256 first, so the comparison is always over 32
 * bytes and leaks no length, and every byte is compared.
 */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const utf8 = new TextEncoder();
  const [x, y] = await Promise.all(
    [a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(s)))),
  );
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
