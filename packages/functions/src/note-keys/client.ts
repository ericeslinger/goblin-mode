// The functions' client for the note key service (note encryption
// step 2; DESIGN.md, "Note encryption", Key custody). A gardener's data
// key is in the Worker's custody; the functions ask it by uid at
// `POST https://<APP_DOMAIN>/api/note-key/for`, and keep each key in
// memory for the life of the instance. The MCP tools and the triggers
// ask for one only when they meet a sealed note (steps 3b and 3c).
//
// They prove who they are with a Google OIDC identity token for the
// function's own runtime service account, minted by the metadata
// server for that route's URL as its audience (Eric, 2026-11-13; it
// replaced a shared service secret). The Worker checks Google's
// signature, the audience and that the account is one it lists.
//
// Configuration comes from the deploy, never from code: APP_DOMAIN is
// written to the functions' environment by scripts/deploy.sh. There is
// no metadata server off Google Cloud, so outside it the ask fails as
// NoteKeysUnconfigured and falls back to nothing weaker; the emulator
// build's stand-in derives keys itself (stand-in.emulator.ts).
import { type DataKey, importDataKey, noteKeyFromWire } from '@mossgoblin/schema';
import { standInNoteKeys } from './stand-in';

/** Where a key's raw bytes come from: the Worker, or a stand-in. */
export type KeySource = (uid: string) => Promise<Uint8Array>;

/** The service is not set up: no domain or metadata server here, or no keys at the Worker. */
export class NoteKeysUnconfigured extends Error {
  override readonly name = 'NoteKeysUnconfigured';
}

/** The Worker or the metadata server refused or failed. Never holds a key or a token. */
export class NoteKeyServiceError extends Error {
  override readonly name = 'NoteKeyServiceError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** How long an ask may take before it is given up. */
export const NOTE_KEY_TIMEOUT_MS = 10_000;

/** The Worker route the functions ask, under the app's origin. */
export const NOTE_KEY_FOR_PATH = '/api/note-key/for';

/** The metadata server's identity endpoint for the default (runtime) service account. */
export const METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
/** How long the metadata server may take; it is on the same host. */
export const METADATA_TIMEOUT_MS = 5_000;
/** A token is minted afresh this long before its `exp`. */
export const TOKEN_EARLY_MS = 5 * 60_000;

/** Identity tokens for one audience, minted when needed and kept until near expiry. */
export interface IdentityTokens {
  token(): Promise<string>;
  /** Forgets `token` (the Worker refused it), so the next `token()` mints anew. */
  forget(token: string): void;
}

export interface MetadataIdentityConfig {
  /** Exactly what the Worker expects as `aud`. */
  audience: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** A JWT's `exp`, in seconds, read without verifying anything; the Worker verifies. */
export function expiryOf(token: string): number | undefined {
  if (!JWT.test(token)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
      exp?: unknown;
    } | null;
    const exp = claims?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Asks the metadata server for identity tokens (`format=full`, so the
 * token carries `email` and `email_verified`), one at a time, and keeps
 * each until TOKEN_EARLY_MS before its `exp`. No answer at all means
 * there is no metadata server here: NoteKeysUnconfigured. Any other
 * failure is a NoteKeyServiceError. No message holds the token.
 */
export function metadataIdentity({
  audience,
  fetch: fetchImpl = fetch,
  now = Date.now,
}: MetadataIdentityConfig): IdentityTokens {
  let held: { token: string; until: number } | undefined;
  let minting: Promise<string> | undefined;
  const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}&format=full`;
  const mint = async (): Promise<string> => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { 'Metadata-Flavor': 'Google' },
        redirect: 'error',
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
    } catch {
      throw new NoteKeysUnconfigured('no metadata server here to mint an identity token');
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new NoteKeyServiceError(`the metadata server answered ${res.status}`, res.status);
    }
    const token = (await res.text().catch(() => '')).trim();
    const exp = expiryOf(token);
    if (exp === undefined) {
      throw new NoteKeyServiceError('the metadata server answered with no identity token');
    }
    const until = exp * 1000 - TOKEN_EARLY_MS;
    held = until > now() ? { token, until } : undefined;
    return token;
  };
  return {
    async token() {
      if (held && now() < held.until) return held.token;
      minting ??= mint().finally(() => (minting = undefined));
      return minting;
    },
    forget(token) {
      if (held?.token === token) held = undefined;
    },
  };
}

export interface WorkerSourceConfig {
  /** The app's origin, e.g. https://notes.example.com; https only. */
  origin: string;
  /** Identity tokens for `${origin}${NOTE_KEY_FOR_PATH}` as their audience. */
  tokens: IdentityTokens;
  fetch?: typeof fetch;
}

/** The audience the Worker expects: the route's full URL on the app's origin. */
export function noteKeyAudience(origin: string): string {
  return `${origin}${NOTE_KEY_FOR_PATH}`;
}

/** Asks the Worker for a uid's key, with a fresh identity token once if it refuses one. */
export function workerSource({
  origin,
  tokens,
  fetch: fetchImpl = fetch,
}: WorkerSourceConfig): KeySource {
  const target = noteKeyAudience(origin);
  const https = (() => {
    try {
      return new URL(target).protocol === 'https:';
    } catch {
      return false;
    }
  })();
  const post = async (token: string, uid: string): Promise<Response> => {
    try {
      return await fetchImpl(target, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ uid }),
        // The token goes to this origin and nowhere a redirect points.
        redirect: 'error',
        signal: AbortSignal.timeout(NOTE_KEY_TIMEOUT_MS),
      });
    } catch (err) {
      const why = err instanceof Error ? err.name : 'error';
      throw new NoteKeyServiceError(`the note key service did not answer (${why})`);
    }
  };
  return async (uid) => {
    if (!https) throw new NoteKeysUnconfigured('the note key service is not an https origin');
    let token = await tokens.token();
    let res = await post(token, uid);
    if (res.status === 401) {
      // A token can be refused near its expiry or after a key rotation:
      // mint another once, and no more.
      await res.body?.cancel();
      tokens.forget(token);
      token = await tokens.token();
      res = await post(token, uid);
    }
    if (res.status === 503) {
      await res.body?.cancel();
      throw new NoteKeysUnconfigured('the Worker has no note keys configured');
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new NoteKeyServiceError(`the note key service answered ${res.status}`, res.status);
    }
    const wire = noteKeyFromWire(await res.json().catch(() => undefined));
    if (!wire) throw new NoteKeyServiceError('the note key service answered with no key', 200);
    return wire.bytes;
  };
}

export interface NoteKeys {
  /** The gardener's data key; kept for the instance once fetched. */
  dataKeyFor(uid: string): Promise<DataKey>;
}

/** A per-instance cache over a key source. A failed ask is not kept, so the next one tries again. */
export function noteKeys(source: KeySource): NoteKeys {
  const held = new Map<string, Promise<DataKey>>();
  return {
    dataKeyFor(uid) {
      if (!uid) return Promise.reject(new RangeError('dataKeyFor needs a uid'));
      let key = held.get(uid);
      if (!key) {
        const asked = source(uid).then((bytes) => importDataKey(bytes));
        held.set(uid, asked);
        asked.catch(() => {
          if (held.get(uid) === asked) held.delete(uid);
        });
        key = asked;
      }
      return key;
    },
  };
}

/** A bare host name, with a port at most: what APP_DOMAIN must be. */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

/** The deployment's client: the emulator stand-in, else the Worker as configured, else unconfigured. */
export function noteKeysFromEnv(env: NodeJS.ProcessEnv): NoteKeys {
  const standIn = standInNoteKeys(env);
  if (standIn) return noteKeys(standIn);
  const domain = env['APP_DOMAIN']?.trim().toLowerCase() ?? '';
  if (!DOMAIN.test(domain)) {
    return noteKeys(async () => {
      throw new NoteKeysUnconfigured('APP_DOMAIN is not set');
    });
  }
  const origin = `https://${domain}`;
  const tokens = metadataIdentity({ audience: noteKeyAudience(origin) });
  return noteKeys(workerSource({ origin, tokens }));
}

let instance: NoteKeys | undefined;

/**
 * A gardener's data key, from the Worker, kept in memory for this
 * instance. Throws `NoteKeysUnconfigured` when the service is not set
 * up, `NoteKeyServiceError` when the Worker refused or failed.
 */
export function dataKeyFor(uid: string): Promise<DataKey> {
  instance ??= noteKeysFromEnv(process.env);
  return instance.dataKeyFor(uid);
}
