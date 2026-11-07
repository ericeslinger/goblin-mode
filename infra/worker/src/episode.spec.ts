import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_KEYS_URL,
  type KeyLookup,
  MAX_EPISODE_BYTES,
  allowedUpstream,
  audioType,
  googleKeys,
  isPublicIPv4,
  isPublicIPv6,
  proxyEpisode,
  verifyIdToken,
} from './episode';

const PROJECT = 'demo-project';
const NOW = Date.parse('2026-11-07T12:00:00Z');
const S = NOW / 1000;
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

let pair: CryptoKeyPair;
let other: CryptoKeyPair;
let jwk: JsonWebKey;
const keys: KeyLookup = async (kid) => (kid === 'k1' ? pair.publicKey : undefined);

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const part = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** A token signed with a key made here, shaped as Firebase makes them. */
async function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key: CryptoKey = pair.privateKey,
): Promise<string> {
  const head = part({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header });
  const body = part({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    auth_time: S - 600,
    iat: S - 60,
    exp: S + 3000,
    sub: 'u1',
    ...claims,
  });
  const sig = await crypto.subtle.sign(RS256, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

beforeAll(async () => {
  const make = () =>
    crypto.subtle.generateKey(
      { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ['sign', 'verify'],
    ) as Promise<CryptoKeyPair>;
  pair = await make();
  other = await make();
  jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
});

describe('verifyIdToken (#180)', () => {
  it('takes a token Firebase would have signed, giving its uid', async () => {
    expect(await verifyIdToken(await token(), PROJECT, keys, NOW)).toBe('u1');
  });

  it('refuses any other project, issuer, time, uid, algorithm, key or signature', async () => {
    const bad = [
      await token({ aud: 'elsewhere' }),
      await token({ iss: 'https://securetoken.google.com/elsewhere' }),
      await token({ exp: S - 1 }),
      await token({ iat: S + 3600 }),
      await token({ auth_time: S + 3600 }),
      await token({ sub: '' }),
      await token({ sub: 7 }),
      await token({}, { alg: 'HS256' }),
      await token({}, { alg: 'none' }),
      await token({}, { kid: 'k2' }),
      await token({}, {}, other.privateKey),
      (await token()).replace(/\.[^.]+$/, '.AAAA'),
      `${(await token()).split('.').slice(0, 2).join('.')}.`,
      'not.a.token',
      'nope',
    ];
    for (const t of bad) expect(await verifyIdToken(t, PROJECT, keys, NOW)).toBeUndefined();
    // A payload swapped under a good signature fails too.
    const [h, , sig] = (await token()).split('.');
    const forged = `${h}.${part({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, iat: S, exp: S + 60, sub: 'u2' })}.${sig}`;
    expect(await verifyIdToken(forged, PROJECT, keys, NOW)).toBeUndefined();
  });
});

describe('googleKeys (#180)', () => {
  it('fetches Google’s keys once, keeps them for max-age, and again for an unknown kid', async () => {
    let now = NOW;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }), {
          headers: { 'cache-control': 'public, max-age=600, must-revalidate' },
        }),
    );
    const lookup = googleKeys(fetcher as typeof fetch, () => now);
    const t = await token();
    expect(await verifyIdToken(t, PROJECT, lookup, NOW)).toBe('u1');
    expect(await lookup('k1')).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(GOOGLE_KEYS_URL);
    // An unknown kid within the minute: no refetch.
    expect(await lookup('k9')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 120_000;
    expect(await lookup('k9')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 600_000;
    await lookup('k1');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('allowedUpstream (#180)', () => {
  it('lets public http(s) links through', () => {
    for (const link of [
      'https://pod.example.com/e/1.mp3',
      'http://media.host.fm/a.m4a?x=1',
      'https://8.8.8.8/a.mp3',
      'https://[2606:4700::1111]/a.mp3',
    ]) {
      expect(allowedUpstream(link)).toBeInstanceOf(URL);
    }
  });

  it('refuses other schemes, credentials, private names and private literals', () => {
    for (const link of [
      'ftp://pod.example.com/a.mp3',
      'file:///etc/passwd',
      'https://user:pw@pod.example.com/a.mp3',
      'https://localhost/a.mp3',
      'https://a.localhost/a.mp3',
      'https://printer.local/a.mp3',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://pod.invalid/a.mp3',
      'https://intranet/a.mp3',
      'https://nas.home.arpa/a.mp3',
      'https://127.0.0.1/a.mp3',
      'https://0x7f.1/a.mp3',
      'https://2130706433/a.mp3',
      'https://10.1.2.3/a.mp3',
      'https://172.20.0.1/a.mp3',
      'https://192.168.1.1/a.mp3',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.1/a.mp3',
      'https://0.0.0.0/a.mp3',
      'https://[::1]/a.mp3',
      'https://[fe80::1]/a.mp3',
      'https://[fd00::1]/a.mp3',
      'https://[::ffff:127.0.0.1]/a.mp3',
      'https://[64:ff9b::a00:1]/a.mp3',
      'https://[2002:7f00:1::]/a.mp3',
      'not a link',
    ]) {
      expect(typeof allowedUpstream(link), link).toBe('string');
    }
  });

  it('checks literals by range', () => {
    expect(isPublicIPv4('1.1.1.1')).toBe(true);
    expect(isPublicIPv4('172.32.0.1')).toBe(true);
    expect(isPublicIPv4('224.0.0.1')).toBe(false);
    expect(isPublicIPv6('2001:4860:4860::8888')).toBe(true);
    expect(isPublicIPv6('2001:db8::1')).toBe(false);
    expect(isPublicIPv6('::')).toBe(false);
  });
});

describe('audioType (#180)', () => {
  it('takes audio, and octet-stream only with an audio extension', () => {
    const mp3 = new URL('https://a.example.com/e.mp3');
    const page = new URL('https://a.example.com/e');
    expect(audioType('audio/mpeg', page)).toBe('audio/mpeg');
    expect(audioType('application/octet-stream', mp3)).toBe('audio/mpeg');
    expect(audioType(null, page, new URL('https://a.example.com/e.m4a'))).toBe('audio/mp4');
    expect(audioType('application/octet-stream', page)).toBeUndefined();
    expect(audioType('text/html; charset=utf-8', mp3)).toBeUndefined();
    expect(audioType('video/mp4', mp3)).toBeUndefined();
  });
});

describe('proxyEpisode (#180)', () => {
  const env = { FIREBASE_PROJECT_ID: PROJECT, OWNER_UID: 'u1' };
  const ask = async (
    headers: Record<string, string> = {},
    link = 'https://pod.example.com/e.mp3',
  ) =>
    new Request(`https://notes.example/api/episode?url=${encodeURIComponent(link)}`, {
      headers: { authorization: `Bearer ${await token()}`, ...headers },
    });
  const upstream = (answer: (url: string, init: RequestInit) => Response | Promise<Response>) =>
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => answer(String(input), init!));

  it('wants a good token, a project and a link', async () => {
    const fetcher = upstream(() => new Response('x'));
    const deps = { fetch: fetcher as typeof fetch, keys, now: NOW };
    const bare = new Request(
      'https://notes.example/api/episode?url=https%3A%2F%2Fa.example.com%2F',
    );
    expect((await proxyEpisode(bare, env, deps)).status).toBe(401);
    const stale = await ask({ authorization: `Bearer ${await token({ exp: S - 1 })}` });
    expect((await proxyEpisode(stale, env, deps)).status).toBe(401);
    expect((await proxyEpisode(await ask(), {}, deps)).status).toBe(503);
    expect((await proxyEpisode(await ask(), { FIREBASE_PROJECT_ID: PROJECT }, deps)).status).toBe(
      503,
    );
    expect((await proxyEpisode(await ask(), { OWNER_UID: 'u1' }, deps)).status).toBe(503);
    // Another account of the same project: signed in, but not the owner.
    const stranger = await ask({ authorization: `Bearer ${await token({ sub: 'u2' })}` });
    expect((await proxyEpisode(stranger, env, deps)).status).toBe(403);
    const none = new Request('https://notes.example/api/episode', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect((await proxyEpisode(none, env, deps)).status).toBe(400);
    const local = await ask({}, 'http://169.254.169.254/latest/meta-data/');
    expect((await proxyEpisode(local, env, deps)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('streams a range through with the headers a player seeks by', async () => {
    const fetcher = upstream(
      () =>
        new Response('0123', {
          status: 206,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': '4',
            'content-range': 'bytes 10-13/100',
            'accept-ranges': 'bytes',
            'set-cookie': 'tracker=1',
          },
        }),
    );
    const res = await proxyEpisode(await ask({ range: 'bytes=10-13' }), env, {
      fetch: fetcher as typeof fetch,
      keys,
      now: NOW,
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('0123');
    expect(Object.fromEntries(res.headers)).toEqual({
      'content-type': 'audio/mpeg',
      'content-length': '4',
      'content-range': 'bytes 10-13/100',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=0',
      'x-content-type-options': 'nosniff',
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://pod.example.com/e.mp3');
    expect(init?.redirect).toBe('manual');
    expect((init?.headers as Record<string, string>)['range']).toBe('bytes=10-13');
    expect((init?.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('follows public redirects by hand and refuses one to a private address', async () => {
    const hops = upstream((url) =>
      url.startsWith('https://pod.example.com/')
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/e' } })
        : new Response('abc', { headers: { 'content-type': 'application/octet-stream' } }),
    );
    const ok = await proxyEpisode(await ask(), env, {
      fetch: hops as typeof fetch,
      keys,
      now: NOW,
    });
    expect(ok.status).toBe(200);
    // The first link's extension says audio, the CDN's says nothing.
    expect(ok.headers.get('content-type')).toBe('audio/mpeg');
    expect(hops.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://pod.example.com/e.mp3',
      'https://cdn.example.net/e',
    ]);
    const sneaky = upstream(
      () => new Response(null, { status: 301, headers: { location: 'http://10.0.0.1/e.mp3' } }),
    );
    const no = await proxyEpisode(await ask(), env, {
      fetch: sneaky as typeof fetch,
      keys,
      now: NOW,
    });
    expect(no.status).toBe(400);
    expect(sneaky).toHaveBeenCalledTimes(1);
    const loop = upstream(
      (url) => new Response(null, { status: 302, headers: { location: `${url}x` } }),
    );
    const far = await proxyEpisode(await ask(), env, {
      fetch: loop as typeof fetch,
      keys,
      now: NOW,
    });
    expect(far.status).toBe(502);
    expect(loop).toHaveBeenCalledTimes(6);
  });

  it('refuses what is not audio, too big, or an error', async () => {
    const run = async (res: Response) =>
      (
        await proxyEpisode(await ask(), env, {
          fetch: upstream(() => res) as typeof fetch,
          keys,
          now: NOW,
        })
      ).status;
    expect(await run(new Response('<html>', { headers: { 'content-type': 'text/html' } }))).toBe(
      415,
    );
    expect(
      await run(
        new Response('x', {
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(MAX_EPISODE_BYTES + 1),
          },
        }),
      ),
    ).toBe(413);
    expect(await run(new Response('gone', { status: 404 }))).toBe(502);
  });
});
