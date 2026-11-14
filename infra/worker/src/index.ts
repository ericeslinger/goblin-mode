// Serves the app's domain (APP_DOMAIN at deploy). Static assets (the
// PWA) are served by Workers Static Assets before this runs; anything
// not found that is a navigation gets index.html (single-page-application
// mode). This script only sees the server routes below and forwards them
// to Cloud Functions, so the MCP endpoint and its OAuth live on the
// app's own origin. Some routes are the Worker's own: `/api/episode`,
// the podcast episode proxy for offline downloads (#180, src/episode.ts),
// and `/api/note-key` with `/api/note-key/for`, the note key service
// (note encryption step 2, src/note-key.ts).

import { type EpisodeEnv, proxyEpisode } from './episode';
import {
  NOTE_KEY_FOR_PATH,
  NOTE_KEY_PATH,
  type NoteKeyEnv,
  appNoteKey,
  serviceNoteKey,
} from './note-key';
import routes from './routes.json';

export interface Env extends EpisodeEnv, NoteKeyEnv {
  ASSETS: Fetcher;
  /** e.g. https://us-central1-<project>.cloudfunctions.net */
  FUNCTIONS_ORIGIN: string;
}

/**
 * Path prefix -> Cloud Function name. Shared with the e2e static server
 * (scripts/serve-static.mjs), so journeys reach functions the same way;
 * every prefix must also be in wrangler.toml's run_worker_first.
 */
export const ROUTES = routes as unknown as ReadonlyArray<readonly [string, string]>;

export function functionFor(pathname: string): string | undefined {
  for (const [prefix, fn] of ROUTES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return fn;
  }
  return undefined;
}

/** The largest share body the fallback reads, in bytes. */
export const MAX_SHARE_BODY = 30 * 1024 * 1024;

/**
 * A share (#46) that reached the server: the app's service worker was
 * not installed yet to take it. The words and link go on to the app in
 * the query, to the share page as `sw.js` sends them (2026-11-14);
 * files cannot be kept here, so a new note says to share them again.
 */
export async function shareFallback(
  request: Request,
  now: () => number = Date.now,
): Promise<Response> {
  const params = new URLSearchParams();
  const home = new URL('/', request.url).toString();
  // Only a share from this device: another site posting here could plant
  // text a later Claude would read (review on #98).
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return Response.redirect(home, 303);
  // Words are small; a body this big is files, which cannot be kept here.
  if (Number(request.headers.get('content-length') ?? 0) > MAX_SHARE_BODY) {
    return Response.redirect(`${home}?shared=lost`, 303);
  }
  try {
    const form = await request.formData();
    for (const key of ['title', 'text', 'url']) {
      const value = form.get(key);
      if (typeof value === 'string' && value.trim()) params.set(key, value);
    }
    if (form.getAll('files').some((f) => typeof f !== 'string')) params.set('shared', 'lost');
  } catch {
    // Not a form: open the app all the same.
  }
  if (params.has('shared') || !params.toString()) {
    return Response.redirect(new URL(`/?${params}`, request.url).toString(), 303);
  }
  const query = boundedShare(params, now());
  return Response.redirect(new URL(`/share?${query}`, request.url).toString(), 303);
}

/** The longest query the share page is sent with its words in it (as sw.js). */
export const MAX_SHARE_QUERY = 8000;

/**
 * The share's fields in a query of at most MAX_SHARE_QUERY characters,
 * with `at` (review on #271): an address much longer can be refused on
 * its way, and here, before the app's worker is installed, there is no
 * cache to keep long words in as `sw.js` keeps them. So the text is cut
 * to fit and `cut` carries its whole length: the page says how much
 * came through and asks for the share again, never losing words
 * quietly. As `boundedShare` in sw.js.
 */
export function boundedShare(params: URLSearchParams, stamp: number): string {
  const text = params.get('text') ?? '';
  const base = new URLSearchParams();
  const title = params.get('title');
  const url = params.get('url');
  if (title) base.set('title', title.slice(0, 1000));
  if (url) base.set('url', url.slice(0, 4096));
  base.set('at', String(stamp));
  const fits = (n: number) => {
    const q = new URLSearchParams(base);
    q.set('text', text.slice(0, n));
    if (n < text.length) q.set('cut', String(text.length));
    return q.toString().length <= MAX_SHARE_QUERY;
  };
  if (!text || fits(text.length)) {
    if (text) base.set('text', text);
    return reorder(base);
  }
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  // Never half a character.
  const code = text.charCodeAt(lo - 1);
  if (lo > 0 && code >= 0xd800 && code <= 0xdbff) lo--;
  base.set('text', text.slice(0, lo));
  base.set('cut', String(text.length));
  return reorder(base);
}

/** title, text, url, then the rest, as the page and the specs read them. */
function reorder(q: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const key of ['title', 'text', 'url', 'at', 'cut']) {
    const v = q.get(key);
    if (v !== null) out.set(key, v);
  }
  return out.toString();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/share') {
      return request.method === 'POST' ? shareFallback(request) : env.ASSETS.fetch(request);
    }
    // The Worker's own routes, before the functions' (#180, note keys).
    if (url.pathname === '/api/episode') return proxyEpisode(request, env);
    if (url.pathname === NOTE_KEY_PATH) return appNoteKey(request, env);
    if (url.pathname === NOTE_KEY_FOR_PATH) return serviceNoteKey(request, env);
    const fn = functionFor(url.pathname);
    if (!fn) return env.ASSETS.fetch(request);
    if (!env.FUNCTIONS_ORIGIN)
      return new Response('functions origin not configured', { status: 503 });

    const target = new URL(`${env.FUNCTIONS_ORIGIN}/${fn}${url.pathname}${url.search}`);
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    return fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });
  },
} satisfies ExportedHandler<Env>;
