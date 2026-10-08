// Serves the app's domain (APP_DOMAIN at deploy). Static assets (the
// PWA) are served by Workers Static Assets before this runs; anything
// not found that is a navigation gets index.html (single-page-application
// mode). This script only sees the server routes below and forwards them
// to Cloud Functions, so the MCP endpoint and its OAuth live on the
// app's own origin.

import routes from './routes.json';

export interface Env {
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
 * the query; files cannot be kept here, so the page says to share again.
 */
export async function shareFallback(request: Request): Promise<Response> {
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
  const target = new URL(`/?${params}`, request.url);
  return Response.redirect(target.toString(), 303);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/share') {
      return request.method === 'POST' ? shareFallback(request) : env.ASSETS.fetch(request);
    }
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
