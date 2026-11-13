import { exportDataKey } from '@mossgoblin/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  METADATA_IDENTITY_URL,
  NoteKeyServiceError,
  NoteKeysUnconfigured,
  TOKEN_EARLY_MS,
  expiryOf,
  metadataIdentity,
  noteKeys,
  noteKeysFromEnv,
  workerSource,
} from './client';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const AUD = 'https://notes.example/api/note-key/for';
const raw = (n: number) => new Uint8Array(32).fill(n);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A token shaped as the metadata server mints them; its signature is not checked here. */
const idToken = (exp: number, n = 1) =>
  `${part({ alg: 'RS256', kid: 'k' })}.${part({ aud: AUD, exp, iat: exp - 3600, n })}.c2ln${n}`;
const TOKEN = idToken(NOW / 1000 + 3600);

/** Tokens that are always `token`, counting asks and forgets. */
function fixedTokens(...tokens: string[]) {
  let i = 0;
  return {
    token: vi.fn(async () => tokens[Math.min(i, tokens.length - 1)]),
    forget: vi.fn(() => {
      i++;
    }),
  };
}

function worker(answer: (uid: string, token: string) => Response | Promise<Response>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { uid } = JSON.parse(String(init?.body)) as { uid: string };
    const token = /^Bearer (.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')?.[1];
    return answer(uid, token ?? '');
  });
}

const keyFor = (uid: string) =>
  Response.json({ v: 1, key: b64(raw(uid === 'u1' ? 1 : 2)) }, { status: 200 });

describe('metadataIdentity (2026-11-13)', () => {
  it('asks the metadata server for a full token for the audience, with its header', async () => {
    const fetch = vi.fn(async () => new Response(`${TOKEN}\n`));
    const tokens = metadataIdentity({ audience: AUD, fetch, now: () => NOW });
    expect(await tokens.token()).toBe(TOKEN);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const asked = new URL(url);
    expect(`${asked.origin}${asked.pathname}`).toBe(METADATA_IDENTITY_URL);
    expect(asked.searchParams.get('audience')).toBe(AUD);
    expect(asked.searchParams.get('format')).toBe('full');
    expect(new Headers(init.headers).get('metadata-flavor')).toBe('Google');
    expect(init.redirect).toBe('error');
  });

  it('keeps a token until shortly before its exp, then mints another', async () => {
    let now = NOW;
    const exp = NOW / 1000 + 3600;
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response(idToken(exp, 1)))
      .mockResolvedValueOnce(new Response(idToken(exp + 3600, 2)));
    const tokens = metadataIdentity({ audience: AUD, fetch, now: () => now });
    const [a, b] = await Promise.all([tokens.token(), tokens.token()]);
    expect(a).toBe(b);
    now = exp * 1000 - TOKEN_EARLY_MS - 1;
    expect(await tokens.token()).toBe(a);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = exp * 1000 - TOKEN_EARLY_MS;
    expect(await tokens.token()).toBe(idToken(exp + 3600, 2));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('mints anew after forgetting the token held', async () => {
    const fetch = vi.fn(async () => new Response(TOKEN));
    const tokens = metadataIdentity({ audience: AUD, fetch, now: () => NOW });
    await tokens.token();
    tokens.forget('some other token');
    await tokens.token();
    expect(fetch).toHaveBeenCalledTimes(1);
    tokens.forget(TOKEN);
    await tokens.token();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('says unconfigured when there is no metadata server, a service error otherwise', async () => {
    const none = metadataIdentity({
      audience: AUD,
      fetch: vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    });
    await expect(none.token()).rejects.toBeInstanceOf(NoteKeysUnconfigured);
    for (const res of [new Response('no', { status: 404 }), new Response('not a token')]) {
      const bad = metadataIdentity({ audience: AUD, fetch: vi.fn(async () => res) });
      await expect(bad.token()).rejects.toBeInstanceOf(NoteKeyServiceError);
    }
  });

  it('reads exp without trusting anything else', () => {
    expect(expiryOf(TOKEN)).toBe(NOW / 1000 + 3600);
    for (const t of ['', 'a.b', 'a.b.c.d', `${part({})}.${part({ exp: 'soon' })}.x`, 'a b.c.d']) {
      expect(expiryOf(t)).toBeUndefined();
    }
  });
});

describe('workerSource (note encryption step 2; identity tokens, 2026-11-13)', () => {
  it('asks the Worker with the identity token, the uid in the body, following no redirect', async () => {
    const fetch = worker(keyFor);
    const tokens = fixedTokens(TOKEN);
    const bytes = await workerSource({ origin: 'https://notes.example', tokens, fetch })('u1');
    expect(bytes).toEqual(raw(1));
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(AUD);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init?.body))).toEqual({ uid: 'u1' });
    expect(init?.redirect).toBe('error');
  });

  it('asks again once, with a fresh token, after a 401', async () => {
    const fresh = idToken(NOW / 1000 + 3600, 2);
    const fetch = worker((uid, token) =>
      token === fresh ? keyFor(uid) : new Response('no', { status: 401 }),
    );
    const tokens = fixedTokens(TOKEN, fresh);
    expect(await workerSource({ origin: 'https://n.example', tokens, fetch })('u1')).toEqual(
      raw(1),
    );
    expect(tokens.forget).toHaveBeenCalledWith(TOKEN);
    expect(fetch).toHaveBeenCalledTimes(2);

    const refusing = worker(() => new Response('no', { status: 401 }));
    const again = fixedTokens(TOKEN, fresh, idToken(NOW / 1000 + 3600, 3));
    await expect(
      workerSource({ origin: 'https://n.example', tokens: again, fetch: refusing })('u1'),
    ).rejects.toMatchObject({ name: 'NoteKeyServiceError', status: 401 });
    expect(refusing).toHaveBeenCalledTimes(2);
    expect(again.forget).toHaveBeenCalledTimes(1);
  });

  it('says unconfigured on a 503, and a service error on any other refusal or bad answer', async () => {
    const ask = (res: Response) =>
      workerSource({
        origin: 'https://n.example',
        tokens: fixedTokens(TOKEN),
        fetch: worker(() => res),
      })('u1');
    await expect(ask(new Response('no', { status: 503 }))).rejects.toBeInstanceOf(
      NoteKeysUnconfigured,
    );
    await expect(ask(new Response('no', { status: 403 }))).rejects.toMatchObject({
      name: 'NoteKeyServiceError',
      status: 403,
    });
    await expect(ask(Response.json({ v: 1, key: 'short' }))).rejects.toBeInstanceOf(
      NoteKeyServiceError,
    );
    await expect(ask(new Response('not json'))).rejects.toBeInstanceOf(NoteKeyServiceError);
    const down = workerSource({
      origin: 'https://n.example',
      tokens: fixedTokens(TOKEN),
      fetch: vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    });
    await expect(down('u1')).rejects.toBeInstanceOf(NoteKeyServiceError);
  });

  it('never sends the token to an origin that is not https', async () => {
    for (const origin of ['http://notes.example', 'notes.example', '']) {
      const fetch = worker(keyFor);
      const tokens = fixedTokens(TOKEN);
      await expect(workerSource({ origin, tokens, fetch })('u1')).rejects.toBeInstanceOf(
        NoteKeysUnconfigured,
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(tokens.token).not.toHaveBeenCalled();
    }
  });

  it('never puts the token, a key or the uid in an error', async () => {
    const secretish = b64(raw(9));
    for (const fetch of [
      worker(() => new Response(`${TOKEN} ${secretish}`, { status: 500 })),
      worker(() => Response.json({ v: 1, key: 'short', token: TOKEN })),
      vi.fn(() => Promise.reject(new TypeError(`fetch failed ${TOKEN}`))),
    ]) {
      const err = await workerSource({
        origin: 'https://n.example',
        tokens: fixedTokens(TOKEN),
        fetch,
      })('uid-that-is-private').catch((e: Error) => e);
      expect(err).toBeInstanceOf(NoteKeyServiceError);
      for (const s of [TOKEN, secretish, 'uid-that-is-private']) {
        expect(String(err)).not.toContain(s);
        expect((err as Error).stack ?? '').not.toContain(s);
      }
    }
  });
});

describe('noteKeys', () => {
  it('asks once per uid and keeps the key for the instance', async () => {
    const source = vi.fn(async (uid: string) => raw(uid === 'u1' ? 1 : 2));
    const keys = noteKeys(source);
    const [a, b] = await Promise.all([keys.dataKeyFor('u1'), keys.dataKeyFor('u1')]);
    expect(a).toBe(b);
    expect(await keys.dataKeyFor('u1')).toBe(a);
    expect(exportDataKey(a)).toEqual(raw(1));
    expect(exportDataKey(await keys.dataKeyFor('u2'))).toEqual(raw(2));
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('keeps no failure, so the next ask tries again', async () => {
    const source = vi
      .fn<(uid: string) => Promise<Uint8Array>>()
      .mockRejectedValueOnce(new NoteKeyServiceError('down'))
      .mockResolvedValue(raw(3));
    const keys = noteKeys(source);
    await expect(keys.dataKeyFor('u1')).rejects.toBeInstanceOf(NoteKeyServiceError);
    expect(exportDataKey(await keys.dataKeyFor('u1'))).toEqual(raw(3));
    expect(source).toHaveBeenCalledTimes(2);
  });
});

describe('noteKeysFromEnv', () => {
  it('throws the typed error when the domain is missing or not a domain', async () => {
    for (const env of [{}, { APP_DOMAIN: '' }, { APP_DOMAIN: 'https://notes.example/' }]) {
      await expect(noteKeysFromEnv(env).dataKeyFor('u1')).rejects.toBeInstanceOf(
        NoteKeysUnconfigured,
      );
    }
  });

  it('fails closed, unconfigured, where there is no metadata server', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    try {
      const keys = noteKeysFromEnv({ APP_DOMAIN: 'notes.example' });
      await expect(keys.dataKeyFor('u1')).rejects.toBeInstanceOf(NoteKeysUnconfigured);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toContain(METADATA_IDENTITY_URL);
    } finally {
      fetch.mockRestore();
    }
  });

  it('mints a token for the app domain route, then asks that route over https', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) =>
        String(url).startsWith(METADATA_IDENTITY_URL) ? new Response(TOKEN) : keyFor('u1'),
      );
    try {
      const keys = noteKeysFromEnv({ APP_DOMAIN: 'Notes.Example' });
      expect(exportDataKey(await keys.dataKeyFor('u1'))).toEqual(raw(1));
      const [mint, ask] = fetch.mock.calls;
      expect(new URL(String(mint[0])).searchParams.get('audience')).toBe(AUD);
      expect(String(ask[0])).toBe(AUD);
      expect(new Headers(ask[1]?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      fetch.mockRestore();
    }
  });

  it('has no stand-in outside the emulator build, even under the emulator', async () => {
    const env = { FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
    await expect(noteKeysFromEnv(env).dataKeyFor('u1')).rejects.toBeInstanceOf(
      NoteKeysUnconfigured,
    );
  });
});
