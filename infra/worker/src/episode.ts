// The episode proxy (#180, epic #177): `/api/episode?url=…` fetches a
// podcast episode for the signed-in gardener and streams it back on
// the app's own origin. Podcast hosts rarely send CORS, so the app
// could only cache an opaque response, which cannot be read or
// seeked; through here the bytes are same-origin, so the app keeps
// them in the Cache Storage and its service worker answers the
// player's byte ranges offline. Cloudflare's egress is free; a
// function's is not (Eric, 2026-11-07).
//
// The Worker cannot resolve a name, so it refuses by what the link
// says: loopback, private, link-local and other special addresses
// written as literals, and the names that only mean something on a
// private network. Every redirect is followed by hand and checked the
// same way. A Worker's fetch leaves from Cloudflare's edge, which has
// no private network or metadata server behind it, so these checks
// are the second line, as `publicRequest`'s are for the functions.

/** What the proxy needs from the Worker's bindings. */
export interface EpisodeEnv {
  /** The Firebase project whose ID tokens are accepted (scripts/deploy.sh). */
  FIREBASE_PROJECT_ID?: string;
  /** The one account the proxy serves, the owner's uid (scripts/deploy.sh). */
  OWNER_UID?: string;
}

/** The largest episode passed through, in bytes. */
export const MAX_EPISODE_BYTES = 500 * 1024 * 1024;
/** Redirects followed before giving up, as `publicRequest` does. */
export const MAX_REDIRECTS = 5;
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

/** Whether a dotted IPv4 address is one a fetch may reach. */
export function isPublicIPv4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return false;
  const [a, b, c] = m.slice(1, 4).map(Number);
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this, private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, the metadata address among them
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** The eight 16-bit groups of an IPv6 address as the URL parser writes it, or undefined. */
function ipv6Groups(address: string): number[] | undefined {
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const side = (s: string) => (s ? s.split(':') : []);
  const head = side(halves[0]);
  const tail = halves.length === 2 ? side(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Whether an IPv6 address is one a fetch may reach: global unicast
 * (2000::/3) only, so no loopback, link-local, unique-local, mapped or
 * NAT64 address, and not documentation, 6to4 or Teredo, which carry
 * an IPv4 address inside.
 */
export function isPublicIPv6(address: string): boolean {
  const g = ipv6Groups(address);
  if (!g) return false;
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return false;
  if (g[0] === 0x2002) return false;
  return true;
}

/** Names that mean something only on a private network, or nothing at all. */
const PRIVATE_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'invalid',
  'test',
  'example',
  'lan',
  'home',
  'corp',
  'intranet',
  'home.arpa',
  'onion',
];

/**
 * The upstream to fetch, or the reason not to: http(s) only, no
 * credentials in the link, an IP literal only when public, and a name
 * only when it has a public-looking suffix (two labels at least, none
 * of the private-network ones).
 */
export function allowedUpstream(link: string | URL): URL | string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return 'not a link';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'only http and https links';
  if (url.username || url.password) return 'a link with credentials in it';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    return isPublicIPv6(host.slice(1, -1)) ? url : `${url.hostname} is not a public address`;
  }
  // The URL parser has already turned 0x7f.1 and 2130706433 into dotted form.
  if (/^[\d.]+$/.test(host)) {
    return isPublicIPv4(host) ? url : `${url.hostname} is not a public address`;
  }
  if (!host.includes('.')) return `${url.hostname} is not a public address`;
  for (const suffix of PRIVATE_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return `${url.hostname} is not a public address`;
    }
  }
  return url;
}

/** Audio types by file extension, for a host that says only octet-stream. */
const AUDIO_EXTENSIONS: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

/**
 * The audio type to send for an upstream's content type and links, or
 * undefined when it is not audio: `audio/*` as given, or an
 * octet-stream (or no type) whose file has an audio extension.
 */
export function audioType(contentType: string | null, ...links: URL[]): string | undefined {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('audio/')) return contentType!.trim();
  if (type && type !== 'application/octet-stream' && type !== 'binary/octet-stream') {
    return undefined;
  }
  for (const link of links) {
    const ext = /\.([a-z0-9]+)$/i.exec(link.pathname)?.[1]?.toLowerCase();
    if (ext && AUDIO_EXTENSIONS[ext]) return AUDIO_EXTENSIONS[ext];
  }
  return undefined;
}

/** The whole file's size an upstream response states, if it states one. */
export function statedSize(res: Response): number | undefined {
  const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1];
  if (total) return Number(total);
  const length = res.headers.get('content-length');
  return length !== null && /^\d+$/.test(length) && res.status === 200 ? Number(length) : undefined;
}

function plain(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/** A body that errors past `max` bytes, for an upstream that states no size. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        seen += chunk.byteLength;
        if (seen > max) out.error(new Error('episode over the size cap'));
        else out.enqueue(chunk);
      },
    }),
  );
}

/** What the proxy reaches the world through, as a seam for specs. */
export interface EpisodeDeps {
  fetch: typeof fetch;
  keys: KeyLookup;
  now?: number;
}

let defaultKeys: KeyLookup | undefined;

/**
 * `/api/episode?url=…` (#180): the caller's Firebase ID token in
 * `Authorization: Bearer`, the owner's (`OWNER_UID`) and no other
 * account's, the episode's link in `url`. The upstream
 * is fetched with the caller's `Range`, redirects followed by hand and
 * each checked, and streamed back when it is audio and under the cap,
 * with its status (200 or 206) and the headers a player seeks by.
 */
export async function proxyEpisode(
  request: Request,
  env: EpisodeEnv,
  deps: EpisodeDeps = {
    fetch: (input, init) => fetch(input, init),
    keys: (defaultKeys ??= googleKeys()),
  },
): Promise<Response> {
  if (request.method !== 'GET') return plain(405, 'GET only', { allow: 'GET' });
  const projectId = env.FIREBASE_PROJECT_ID;
  const owner = env.OWNER_UID;
  if (!projectId || !owner) return plain(503, 'episode downloads are not configured');
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  const uid = bearer ? await verifyIdToken(bearer, projectId, deps.keys, deps.now) : undefined;
  if (!uid) return plain(401, 'sign in first', { 'www-authenticate': 'Bearer' });
  // The owner's only: a token of any other account of the project is refused.
  if (uid !== owner) return plain(403, 'not this account');

  const link = new URL(request.url).searchParams.get('url');
  if (!link) return plain(400, 'no url');
  const first = allowedUpstream(link);
  if (typeof first === 'string') return plain(400, first);

  const range = request.headers.get('range');
  let url = first;
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      res = await deps.fetch(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': 'Mossgoblin/1 (downloading a podcast episode)',
          ...(range ? { range } : {}),
        },
      });
    } catch {
      // Refused, reset or timed out: the host's fault, not ours (review on #192).
      return plain(502, `could not reach ${url.hostname}`);
    }
    if (res.status < 300 || res.status >= 400 || res.status === 304) break;
    await res.body?.cancel();
    const next = res.headers.get('location');
    if (!next) return plain(502, `a redirect with nowhere to go (${res.status})`);
    let target: URL;
    try {
      target = new URL(next, url);
    } catch {
      return plain(502, `a redirect to a link that does not parse (${res.status})`);
    }
    const checked = allowedUpstream(target);
    if (typeof checked === 'string') return plain(400, `redirected: ${checked}`);
    url = checked;
    res = undefined;
  }
  if (!res) return plain(502, 'too many redirects');
  if (res.status === 416) {
    await res.body?.cancel();
    const total = res.headers.get('content-range');
    return plain(416, 'range not satisfiable', total ? { 'content-range': total } : {});
  }
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel();
    return plain(502, `the host answered ${res.status}`);
  }
  const type = audioType(res.headers.get('content-type'), url, first);
  if (!type) {
    await res.body?.cancel();
    return plain(415, 'not audio');
  }
  const size = statedSize(res);
  if (size !== undefined && size > MAX_EPISODE_BYTES) {
    await res.body?.cancel();
    return plain(413, `over ${MAX_EPISODE_BYTES / (1024 * 1024)} MB`);
  }
  const headers = new Headers({
    'content-type': type,
    'cache-control': 'private, max-age=0',
    'x-content-type-options': 'nosniff',
    'accept-ranges': res.headers.get('accept-ranges') ?? (res.status === 206 ? 'bytes' : 'none'),
  });
  for (const name of ['content-length', 'content-range']) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  const body = res.body && size === undefined ? capped(res.body, MAX_EPISODE_BYTES) : res.body;
  return new Response(body, { status: res.status, headers });
}
