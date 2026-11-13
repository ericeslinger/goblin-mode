import { beforeAll, describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, deriveNoteKey } from '../../../packages/schema/src/note-key';
import type { KeyLookup } from './id-token';
import worker, { type Env } from './index';
import { appNoteKey, noteKeyCallers, serviceAudience, serviceNoteKey } from './note-key';

const PROJECT = 'demo-project';
const NOW = Date.parse('2026-11-12T12:00:00Z');
const S = NOW / 1000;
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const MASTER = new Uint8Array(32).map((_, i) => (i * 13 + 5) & 255);
const AUD = 'https://notes.example/api/note-key/for';
const CALLER = 'runner@demo-project.iam.gserviceaccount.com';
const CALLERS = `${CALLER}, 123-compute@developer.gserviceaccount.com`;
const env = {
  FIREBASE_PROJECT_ID: PROJECT,
  NOTE_KEYS_MASTER: bytesToBase64(MASTER),
  APP_DOMAIN: 'notes.example',
  NOTE_KEY_CALLERS: CALLERS,
};

let pair: CryptoKeyPair;
/** Signs the Google OIDC tokens here; in the OIDC key set as `g1`. */
let google: CryptoKeyPair;
/** A key in neither set. */
let stranger: CryptoKeyPair;
const keys: KeyLookup = async (kid) => (kid === 'k1' ? pair.publicKey : undefined);
const oidcKeys: KeyLookup = async (kid) => (kid === 'g1' ? google.publicKey : undefined);
const deps = () => ({ keys, now: NOW });
const oidcDeps = () => ({ keys: oidcKeys, now: NOW });

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

/** A Google OIDC identity token, shaped as the metadata server mints them (format=full). */
async function identity(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signer: CryptoKeyPair = google,
): Promise<string> {
  const head = part({ alg: 'RS256', kid: 'g1', typ: 'JWT', ...header });
  const body = part({
    iss: 'https://accounts.google.com',
    aud: AUD,
    azp: '1234567890',
    sub: '1234567890',
    email: CALLER,
    email_verified: true,
    iat: S - 60,
    exp: S + 3540,
    ...claims,
  });
  const sig = await crypto.subtle.sign(
    RS256,
    signer.privateKey,
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

const newPair = async () =>
  (await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

beforeAll(async () => {
  [pair, google, stranger] = await Promise.all([newPair(), newPair(), newPair()]);
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

describe('POST /api/note-key/for (identity tokens, 2026-11-13)', () => {
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  it("answers an allowed service account with the named uid's key", async () => {
    const res = await serviceNoteKey(
      askFor({ uid: 'u2' }, bearer(await identity())),
      env,
      oidcDeps(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await keyOf(res)).toBe(await derived('u2'));
    const bare = await identity({ iss: 'accounts.google.com', email: CALLER.toUpperCase() });
    const two = await serviceNoteKey(askFor({ uid: 'u1' }, bearer(bare)), env, oidcDeps());
    expect(await keyOf(two)).toBe(await derived('u1'));
  });

  it('refuses a missing token, or one that fails any check', async () => {
    const good = await identity();
    const [head, body] = good.split('.');
    const unsigned = `${head}.${body}.`;
    const none = `${part({ alg: 'none', kid: 'g1', typ: 'JWT' })}.${body}.`;
    const hmac = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('a shared secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const hsHead = part({ alg: 'HS256', kid: 'g1', typ: 'JWT' });
    const hsSig = await crypto.subtle.sign(
      'HMAC',
      hmac,
      new TextEncoder().encode(`${hsHead}.${body}`),
    );
    const hs256 = `${hsHead}.${body}.${b64url(new Uint8Array(hsSig))}`;
    const bad: [string, Record<string, string>][] = [
      ['no token', {}],
      ['not a token', bearer('nope')],
      ['not bearer', { authorization: `Basic ${good}` }],
      [
        'wrong audience',
        bearer(await identity({ aud: 'https://elsewhere.example/api/note-key/for' })),
      ],
      [
        'the app route as audience',
        bearer(await identity({ aud: 'https://notes.example/api/note-key' })),
      ],
      ['audience as a list', bearer(await identity({ aud: [AUD] }))],
      ['wrong issuer', bearer(await identity({ iss: 'https://accounts.example.com' }))],
      [
        'Firebase issuer',
        bearer(await identity({ iss: `https://securetoken.google.com/${PROJECT}` })),
      ],
      ['expired', bearer(await identity({ exp: S - 1, iat: S - 3601 }))],
      ['not yet valid', bearer(await identity({ iat: S + 600, exp: S + 4200 }))],
      ['lives too long', bearer(await identity({ exp: S + 86_400 }))],
      ['no exp', bearer(await identity({ exp: undefined }))],
      ['email not verified', bearer(await identity({ email_verified: false }))],
      ['email verified as a string', bearer(await identity({ email_verified: 'true' }))],
      ['no email', bearer(await identity({ email: undefined }))],
      ['unsigned', bearer(unsigned)],
      ['alg none', bearer(none)],
      ['HS256', bearer(hs256)],
      ['signature tampered', bearer(good.replace(/\.[^.]+$/, '.AAAA'))],
      [
        'claims tampered',
        bearer(
          `${head}.${part({ ...JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))), email: 'x@y.example' })}.${good.split('.')[2]}`,
        ),
      ],
      ['a key not in the set', bearer(await identity({}, { kid: 'g2' }, stranger))],
      ['a stranger signing as g1', bearer(await identity({}, {}, stranger))],
      ['a Firebase ID token', bearer(await token())],
      [
        'a Firebase ID token for this audience',
        bearer(await token({ aud: AUD, email: CALLER, email_verified: true })),
      ],
    ];
    for (const [why, headers] of bad) {
      const res = await serviceNoteKey(askFor({ uid: 'u1' }, headers), env, oidcDeps());
      expect(res.status, why).toBe(401);
      expect(await res.text()).not.toContain(env.NOTE_KEYS_MASTER);
    }
  });

  it('refuses a Firebase ID token even when its signer is in the lookup', async () => {
    // Right signer family, wrong key set and issuer: were the Firebase
    // keys ever looked up here by mistake, the issuer still refuses it.
    const both: KeyLookup = async (kid) => (await keys(kid)) ?? oidcKeys(kid);
    const res = await serviceNoteKey(
      askFor({ uid: 'u1' }, bearer(await token({ aud: AUD, email: CALLER, email_verified: true }))),
      env,
      { keys: both, now: NOW },
    );
    expect(res.status).toBe(401);
  });

  it('refuses, 403, a good token for an account not on the list', async () => {
    for (const email of [
      'goblin-keys@demo-project.iam.gserviceaccount.com',
      `${CALLER}.evil.example`,
      `x${CALLER}`,
      'someone@gmail.com',
    ]) {
      const res = await serviceNoteKey(
        askFor({ uid: 'u1' }, bearer(await identity({ email }))),
        env,
        oidcDeps(),
      );
      expect(res.status, email).toBe(403);
    }
  });

  it('fixes the audience from APP_DOMAIN, whatever host the request names', async () => {
    const t = await identity({ aud: 'https://attacker.example/api/note-key/for' });
    const req = new Request('https://attacker.example/api/note-key/for', {
      method: 'POST',
      headers: { ...bearer(t), host: 'attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'u1' }),
    });
    expect((await serviceNoteKey(req, env, oidcDeps())).status).toBe(401);
    expect(serviceAudience({ APP_DOMAIN: ' Notes.Example ' })).toBe(AUD);
    for (const APP_DOMAIN of [undefined, '', 'https://notes.example', 'notes.example/x']) {
      expect(serviceAudience({ APP_DOMAIN })).toBeUndefined();
    }
  });

  it('reads the allowlist as exact emails', () => {
    expect([
      ...noteKeyCallers({ NOTE_KEY_CALLERS: ` A@b.example,c@d.example\n e@f.example ,, nope ` }),
    ]).toEqual(['a@b.example', 'c@d.example', 'e@f.example']);
    expect(noteKeyCallers({}).size).toBe(0);
  });

  it('refuses everyone, 503, without an allowlist, a domain or the master', async () => {
    const t = bearer(await identity());
    for (const missing of [
      { NOTE_KEY_CALLERS: undefined },
      { NOTE_KEY_CALLERS: '' },
      { NOTE_KEY_CALLERS: ' , ' },
      { APP_DOMAIN: undefined },
      { NOTE_KEYS_MASTER: undefined },
    ]) {
      const res = await serviceNoteKey(
        askFor({ uid: 'u1' }, t),
        { ...env, ...missing },
        oidcDeps(),
      );
      expect(res.status).toBe(503);
    }
  });

  it('answers POST only, and not to another site', async () => {
    const t = bearer(await identity());
    const get = new Request(AUD, { method: 'GET', headers: t });
    expect((await serviceNoteKey(get, env, oidcDeps())).status).toBe(405);
    const res = await serviceNoteKey(
      askFor({ uid: 'u1' }, { ...t, 'sec-fetch-site': 'cross-site' }),
      env,
      oidcDeps(),
    );
    expect(res.status).toBe(403);
  });

  it('refuses a body without a uid', async () => {
    const headers = bearer(await identity());
    for (const body of ['nope', {}, { uid: '' }, { uid: 7 }, { uid: 'x'.repeat(129) }, 'null']) {
      expect((await serviceNoteKey(askFor(body, headers), env, oidcDeps())).status).toBe(400);
    }
    const big = askFor({ uid: 'u1', pad: 'x'.repeat(2000) }, headers);
    expect((await serviceNoteKey(big, env, oidcDeps())).status).toBe(413);
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
    const svc = await worker.fetch(askFor({ uid: 'u1' }, { authorization: 'Bearer nope' }), full);
    expect(svc.status).toBe(401);
    const off = await worker.fetch(askFor({ uid: 'u1' }), { ...full, NOTE_KEY_CALLERS: '' });
    expect(off.status).toBe(503);
  });
});
