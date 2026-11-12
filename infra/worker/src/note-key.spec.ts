import { beforeAll, describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, deriveNoteKey } from '../../../packages/schema/src/note-key';
import type { KeyLookup } from './id-token';
import worker, { type Env } from './index';
import { appNoteKey, sameSecret, serviceNoteKey } from './note-key';

const PROJECT = 'demo-project';
const NOW = Date.parse('2026-11-12T12:00:00Z');
const S = NOW / 1000;
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const MASTER = new Uint8Array(32).map((_, i) => (i * 13 + 5) & 255);
const SERVICE = 'a-service-secret-that-is-long-enough-1234';
const env = {
  FIREBASE_PROJECT_ID: PROJECT,
  NOTE_KEYS_MASTER: bytesToBase64(MASTER),
  NOTE_KEYS_SERVICE: SERVICE,
};

let pair: CryptoKeyPair;
const keys: KeyLookup = async (kid) => (kid === 'k1' ? pair.publicKey : undefined);
const deps = () => ({ keys, now: NOW });

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const part = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** A token signed with a key made here, shaped as Firebase makes them. */
async function token(claims: Record<string, unknown> = {}): Promise<string> {
  const head = part({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = part({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    auth_time: S - 600,
    iat: S - 60,
    exp: S + 3000,
    sub: 'u1',
    ...claims,
  });
  const sig = await crypto.subtle.sign(
    RS256,
    pair.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

function ask(headers: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request('https://notes.example/api/note-key', { method: 'POST', headers, ...init });
}

function askFor(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://notes.example/api/note-key/for', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function keyOf(res: Response): Promise<string> {
  const body = (await res.json()) as { v: number; key: string };
  expect(body.v).toBe(1);
  expect(base64ToBytes(body.key)?.length).toBe(32);
  return body.key;
}

const derived = async (uid: string) => bytesToBase64(await deriveNoteKey(MASTER, uid, 1));

beforeAll(async () => {
  pair = (await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
});

describe('POST /api/note-key (note encryption step 2)', () => {
  it("answers with the token's own uid's key, uncached", async () => {
    const res = await appNoteKey(ask({ authorization: `Bearer ${await token()}` }), env, deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(await keyOf(res)).toBe(await derived('u1'));
    const two = await appNoteKey(
      ask({ authorization: `Bearer ${await token({ sub: 'u2' })}` }),
      env,
      deps(),
    );
    expect(await keyOf(two)).toBe(await derived('u2'));
    expect(await derived('u2')).not.toBe(await derived('u1'));
  });

  it('takes the uid from the token alone, never from the request', async () => {
    const req = new Request('https://notes.example/api/note-key?uid=u2', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'u2' }),
    });
    expect(await keyOf(await appNoteKey(req, env, deps()))).toBe(await derived('u1'));
  });

  it('refuses a missing, bad, expired or other-project token', async () => {
    const bad: Record<string, string>[] = [
      {},
      { authorization: 'Bearer nope' },
      { authorization: `Basic ${await token()}` },
      { authorization: `Bearer ${await token({ aud: 'elsewhere' })}` },
      {
        authorization: `Bearer ${await token({ iss: 'https://securetoken.google.com/elsewhere' })}`,
      },
      { authorization: `Bearer ${await token({ exp: S - 1 })}` },
      { authorization: `Bearer ${(await token()).replace(/\.[^.]+$/, '.AAAA')}` },
    ];
    for (const headers of bad) {
      const res = await appNoteKey(ask(headers), env, deps());
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(env.NOTE_KEYS_MASTER);
    }
  });

  it('answers 503 without the master, or with one that is not 32 bytes', async () => {
    const authorization = `Bearer ${await token()}`;
    for (const master of [undefined, '', bytesToBase64(new Uint8Array(16)), 'not base64!']) {
      const res = await appNoteKey(
        ask({ authorization }),
        { ...env, NOTE_KEYS_MASTER: master },
        deps(),
      );
      expect(res.status).toBe(503);
    }
    const res = await appNoteKey(
      ask({ authorization }),
      { ...env, FIREBASE_PROJECT_ID: undefined },
      deps(),
    );
    expect(res.status).toBe(503);
  });

  it('answers POST only, and not to another site', async () => {
    const authorization = `Bearer ${await token()}`;
    expect((await appNoteKey(ask({ authorization }, { method: 'GET' }), env, deps())).status).toBe(
      405,
    );
    for (const site of ['cross-site', 'same-site']) {
      const res = await appNoteKey(ask({ authorization, 'sec-fetch-site': site }), env, deps());
      expect(res.status).toBe(403);
    }
    const same = await appNoteKey(
      ask({ authorization, 'sec-fetch-site': 'same-origin' }),
      env,
      deps(),
    );
    expect(same.status).toBe(200);
  });
});

describe('POST /api/note-key/for (note encryption step 2)', () => {
  it("answers the service with the named uid's key", async () => {
    const res = await serviceNoteKey(
      askFor({ uid: 'u2' }, { authorization: `Bearer ${SERVICE}` }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await keyOf(res)).toBe(await derived('u2'));
  });

  it('refuses a missing or wrong secret', async () => {
    const wrong: Record<string, string>[] = [
      {},
      { authorization: 'Bearer wrong' },
      { authorization: `Bearer ${SERVICE}x` },
      { authorization: `Bearer ${SERVICE.slice(0, -1)}` },
      { authorization: SERVICE },
    ];
    for (const headers of wrong) {
      expect((await serviceNoteKey(askFor({ uid: 'u1' }, headers), env)).status).toBe(401);
    }
  });

  it('refuses everything without a service secret, or with one too short', async () => {
    for (const secret of [undefined, '', 'short']) {
      const res = await serviceNoteKey(
        askFor({ uid: 'u1' }, { authorization: `Bearer ${secret ?? ''}` }),
        { ...env, NOTE_KEYS_SERVICE: secret },
      );
      expect(res.status).toBe(503);
    }
    const noMaster = await serviceNoteKey(
      askFor({ uid: 'u1' }, { authorization: `Bearer ${SERVICE}` }),
      { ...env, NOTE_KEYS_MASTER: undefined },
    );
    expect(noMaster.status).toBe(503);
  });

  it('refuses a body without a uid', async () => {
    const authorization = `Bearer ${SERVICE}`;
    for (const body of ['nope', {}, { uid: '' }, { uid: 7 }, { uid: 'x'.repeat(129) }, 'null']) {
      expect((await serviceNoteKey(askFor(body, { authorization }), env)).status).toBe(400);
    }
    const big = askFor({ uid: 'u1', pad: 'x'.repeat(2000) }, { authorization });
    expect((await serviceNoteKey(big, env)).status).toBe(413);
  });
});

describe('sameSecret', () => {
  it('is equality, whatever the lengths', async () => {
    expect(await sameSecret('abc', 'abc')).toBe(true);
    expect(await sameSecret('abc', 'abd')).toBe(false);
    expect(await sameSecret('abc', 'abcd')).toBe(false);
    expect(await sameSecret('', 'a')).toBe(false);
  });
});

describe('the Worker routes note keys itself', () => {
  it('answers both paths without reaching the assets or the functions', async () => {
    const full = {
      ...env,
      FUNCTIONS_ORIGIN: 'https://functions.invalid',
      ASSETS: { fetch: () => Promise.reject(new Error('reached the assets')) },
    } as unknown as Env;
    const app = await worker.fetch(ask(), full);
    expect(app.status).toBe(401);
    const svc = await worker.fetch(
      askFor({ uid: 'u1' }, { authorization: `Bearer ${SERVICE}` }),
      full,
    );
    expect(await keyOf(svc)).toBe(await derived('u1'));
  });
});
