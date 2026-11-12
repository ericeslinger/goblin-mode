// The functions' client for the note key service (note encryption
// step 2; DESIGN.md, "Note encryption", Key custody). A gardener's data
// key is in the Worker's custody; the functions ask it by uid at
// `POST https://<APP_DOMAIN>/api/note-key/for` with the service secret,
// and keep each key in memory for the life of the instance. Nothing
// calls this yet but its specs.
//
// Configuration comes from the deploy, never from code: APP_DOMAIN is
// written to the functions' environment by scripts/deploy.sh, and
// NOTE_KEYS_SERVICE is a Secret Manager secret (secret.ts) that a
// function bound to it sees in its environment. Under the emulator the
// emulator build's stand-in derives keys itself (stand-in.emulator.ts).
import { type DataKey, importDataKey, noteKeyFromWire } from '@mossgoblin/schema';
import { standInNoteKeys } from './stand-in';

/** Where a key's raw bytes come from: the Worker, or a stand-in. */
export type KeySource = (uid: string) => Promise<Uint8Array>;

/** The service is not set up: no domain or secret here, or none at the Worker. */
export class NoteKeysUnconfigured extends Error {
  override readonly name = 'NoteKeysUnconfigured';
}

/** The Worker refused or failed. Never holds a key or the secret. */
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

export interface WorkerSourceConfig {
  /** The app's origin, e.g. https://notes.example.com. */
  origin: string;
  /** The service secret, as the Worker holds it. */
  secret: string;
  fetch?: typeof fetch;
}

/** Asks the Worker for a uid's key. */
export function workerSource({
  origin,
  secret,
  fetch: fetchImpl = fetch,
}: WorkerSourceConfig): KeySource {
  return async (uid) => {
    let res: Response;
    try {
      res = await fetchImpl(`${origin}/api/note-key/for`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ uid }),
        // The secret goes to this origin and nowhere a redirect points.
        redirect: 'error',
        signal: AbortSignal.timeout(NOTE_KEY_TIMEOUT_MS),
      });
    } catch (err) {
      throw new NoteKeyServiceError(`the note key service did not answer: ${String(err)}`);
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
  const domain = env['APP_DOMAIN']?.trim() ?? '';
  const secret = env['NOTE_KEYS_SERVICE']?.trim() ?? '';
  if (!DOMAIN.test(domain) || !secret) {
    return noteKeys(async () => {
      throw new NoteKeysUnconfigured(
        !secret
          ? 'NOTE_KEYS_SERVICE is not set (or not bound to this function)'
          : 'APP_DOMAIN is not set',
      );
    });
  }
  return noteKeys(workerSource({ origin: `https://${domain}`, secret }));
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
