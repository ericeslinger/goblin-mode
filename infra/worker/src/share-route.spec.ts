import {
  NOT_FOUND_PAGE,
  SHARE_HEADERS,
  UNAVAILABLE_PAGE,
} from '../../../packages/schema/src/share-shell';
import { describe, expect, it, vi } from 'vitest';
import worker, { functionFor } from './index';
import { isSharePath, serveShare } from './share-route';

const ID = 'AbCdEfGhIjKlMnOpQrStUvWxYz012-_9';
const get = (path: string, init: RequestInit = {}) =>
  new Request(`https://notes.example${path}`, init);
const PAGE = '<!doctype html><h1>Glaze</h1>';

/** A function that answers `status` with `body`, recording what it was sent. */
function fn(status: number, body = PAGE, headers: Record<string, string> = {}) {
  return vi.fn(async (_r: Request) => new Response(body, { status, headers }));
}

/** Every header of `res` as the page's own, and nothing else. */
function expectPageHeaders(res: Response, more: Record<string, string> = {}) {
  expect(Object.fromEntries(res.headers)).toEqual({ ...SHARE_HEADERS, ...more });
}

describe('the /s route', () => {
  it('is /s and everything under it, nothing else', () => {
    expect(isSharePath(`/s/${ID}`)).toBe(true);
    expect(isSharePath('/s')).toBe(true);
    expect(isSharePath('/share')).toBe(false);
    expect(isSharePath('/settings')).toBe(false);
    expect(isSharePath('/reader/s/feed')).toBe(false);
    // In the route table, so the e2e static server forwards it too.
    expect(functionFor(`/s/${ID}`)).toBe('publicShare');
  });

  it('forwards a well-formed id to the function, sending nothing of the reader’s', async () => {
    const forward = fn(200);
    const res = await serveShare(
      get(`/s/${ID}`, { headers: { cookie: 'a=b', authorization: 'Bearer x' } }),
      forward,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
    const sent = forward.mock.calls[0][0];
    expect(sent.url).toBe(`https://notes.example/s/${ID}`);
    expect(sent.headers.get('cookie')).toBeNull();
    expect(sent.headers.get('authorization')).toBeNull();
    expectPageHeaders(res);
  });

  it('puts the page’s own headers on what comes back, whatever the function sent', async () => {
    const res = await serveShare(
      get(`/s/${ID}`),
      fn(200, PAGE, {
        'content-security-policy': 'default-src *',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=3600',
        'set-cookie': 'x=y',
      }),
    );
    expectPageHeaders(res);
  });

  it('refuses a malformed id itself, with the one 404, before forwarding', async () => {
    const forward = fn(200);
    for (const p of ['/s/nope', '/s/', '/s', `/s/${ID}/more`, `/s/${ID}x`, '/s/..%2F..%2Fusers']) {
      const res = await serveShare(get(p), forward);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(NOT_FOUND_PAGE);
      expectPageHeaders(res);
    }
    expect(forward).not.toHaveBeenCalled();
  });

  it('answers the function’s 404 with the same bytes, and anything else as unavailable', async () => {
    const notThere = await serveShare(get(`/s/${ID}`), fn(404, 'Cloud Run says not found'));
    expect(notThere.status).toBe(404);
    expect(await notThere.text()).toBe(NOT_FOUND_PAGE);
    for (const status of [500, 502, 403, 302]) {
      const res = await serveShare(get(`/s/${ID}`), fn(status, 'stack trace'));
      expect(res.status).toBe(503);
      expect(await res.text()).toBe(UNAVAILABLE_PAGE);
      expectPageHeaders(res, { 'retry-after': '60' });
    }
    const down = await serveShare(get(`/s/${ID}`), async () => Promise.reject(new Error('x')));
    expect(down.status).toBe(503);
    expect((await serveShare(get(`/s/${ID}`), undefined)).status).toBe(503);
  });

  it('takes HEAD with no body and refuses anything but GET and HEAD', async () => {
    const head = await serveShare(get(`/s/${ID}`, { method: 'HEAD' }), fn(200));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const forward = fn(200);
    const post = await serveShare(get(`/s/${ID}`, { method: 'POST', body: 'x' }), forward);
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect(forward).not.toHaveBeenCalled();
  });

  it('is the Worker’s, ahead of the app shell, sent to FUNCTIONS_ORIGIN', async () => {
    const assets = { fetch: vi.fn(async () => new Response('app shell')) };
    const real = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((async () => new Response(PAGE)) as unknown as typeof fetch);
    try {
      const env = {
        ASSETS: assets as unknown as Fetcher,
        FUNCTIONS_ORIGIN: 'https://fns.example',
      };
      const res = await worker.fetch(get(`/s/${ID}`), env);
      expect(res.status).toBe(200);
      expect(assets.fetch).not.toHaveBeenCalled();
      expect(String(real.mock.calls[0][0])).toBe(`https://fns.example/publicShare/s/${ID}`);
      const bad = await worker.fetch(get('/s/bad'), env);
      expect(bad.status).toBe(404);
      expect(real).toHaveBeenCalledTimes(1);
    } finally {
      real.mockRestore();
    }
  });
});
