import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicRequest } from '../attachments/import';
import { DISCOVER_MAX_BYTES, discoverFeedFetch, discoverPageFetch, feedFetch } from './fetch';
import { FEED_MAX_BYTES } from './refresh';

// A public address, so the fetch guard needs no DNS.
const URL_ = 'http://93.184.216.34/feed.xml';

/**
 * A body of `size` bytes served in 64 KB chunks as they are asked for,
 * `content-length` declared, counting what the reader pulled and
 * whether it cancelled.
 */
function served(size: number, fill = 0x61, headers: Record<string, string> = {}) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const n = Math.min(64 * 1024, size - state.pulled);
      if (n <= 0) return controller.close();
      state.pulled += n;
      controller.enqueue(new Uint8Array(n).fill(fill));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const res = new Response(body, {
    headers: { 'content-type': 'application/rss+xml', 'content-length': String(size), ...headers },
  });
  return { res, state };
}

afterEach(() => vi.unstubAllGlobals());

describe('publicRequest past maxBytes (2026-11-16)', () => {
  it('fails by default, on the declared length or on the bytes read', async () => {
    vi.stubGlobal('fetch', async () => served(3 * 1024 * 1024).res);
    await expect(publicRequest(URL_, { maxBytes: 2 * 1024 * 1024 })).rejects.toThrow(
      'the page is over 2 MB',
    );
    const { res, state } = served(3 * 1024 * 1024);
    res.headers.delete('content-length');
    vi.stubGlobal('fetch', async () => res);
    await expect(publicRequest(URL_, { maxBytes: 2 * 1024 * 1024 })).rejects.toThrow(
      'the page is over 2 MB',
    );
    expect(state.cancelled).toBe(true);
  });

  it('with truncate, keeps exactly maxBytes, stops reading and says so', async () => {
    const { res, state } = served(40 * 1024 * 1024);
    vi.stubGlobal('fetch', async () => res);
    const max = 1_000_001; // not a chunk boundary
    const out = await publicRequest(URL_, { maxBytes: max, overflow: 'truncate' });
    expect(out.truncated).toBe(true);
    expect(out.bytes.length).toBe(max);
    expect(state.cancelled).toBe(true);
    // One chunk past the cap at most, never the 40 MB.
    expect(state.pulled).toBeLessThanOrEqual(max + 2 * 64 * 1024);
  });

  it('with truncate, a body that fits is whole and not marked', async () => {
    vi.stubGlobal('fetch', async () => served(FEED_MAX_BYTES).res);
    const out = await publicRequest(URL_, { maxBytes: FEED_MAX_BYTES, overflow: 'truncate' });
    expect(out.truncated).toBeUndefined();
    expect(out.bytes.length).toBe(FEED_MAX_BYTES);
  });
});

describe('the feed fetchers read a large feed in part (2026-11-16)', () => {
  it('feedFetch: the first 5 MB, marked, the validators kept', async () => {
    vi.stubGlobal(
      'fetch',
      async () => served(12 * 1024 * 1024, 0x61, { etag: '"big"', 'last-modified': 'x' }).res,
    );
    const res = await feedFetch(URL_, {});
    expect(res).toMatchObject({ status: 200, truncated: true, etag: '"big"', lastModified: 'x' });
    expect(res.text.length).toBe(FEED_MAX_BYTES);
  });

  it('feedFetch: a 304 is untouched', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(null, { status: 304, headers: { etag: '"a"' } }),
    );
    const res = await feedFetch(URL_, { etag: '"a"' });
    expect(res).toEqual({ status: 304, contentType: '', text: '', etag: '"a"' });
  });

  it('discovery: the candidate feed and the pasted address, at 2 MB', async () => {
    vi.stubGlobal('fetch', async () => served(9 * 1024 * 1024).res);
    const feed = await discoverFeedFetch(URL_, {});
    expect(feed.truncated).toBe(true);
    expect(feed.text.length).toBe(DISCOVER_MAX_BYTES);
    const page = await discoverPageFetch(URL_);
    expect(page.truncated).toBe(true);
    expect(page.bytes.length).toBe(DISCOVER_MAX_BYTES);
  });
});
