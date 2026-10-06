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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
