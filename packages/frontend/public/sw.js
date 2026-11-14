// The app's service worker: the share target (#46), downloaded podcast
// episodes (#180), then Angular's.
//
// A share from another app is a POST to /share (manifest share_target).
// The files go into a cache the page reads at /?shared=<n>; the title,
// text and link ride along in the query. Words and a link alone go to
// the share page, /share?title&text&url&at (2026-11-14), `at` the
// moment they were taken, so a reload of it is known for the same
// share. Listened for before Angular's worker loads, which would answer
// every fetch itself.
//
// Words too long for an address (a recipe page, selected all) are kept
// in the share words cache instead, and the address carries their id,
// /share?stash=<at>&at=<at> (review on #271): a long address can be
// refused once it reaches the server. The page reads them back from
// here, and deletes them once the share is filed or let go.
const SHARE_CACHE = 'mossgoblin-share';
/** Words too long for the share page's address (share-store.ts). */
const SHARE_WORDS_CACHE = 'mossgoblin-share-words';
/** The longest query the share page is sent with its words in it. */
const MAX_SHARE_QUERY = 8000;
/** Stashed words never filed are dropped after this long. */
const SHARE_WORDS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Episodes the app downloaded through the Worker's /api/episode (#180). */
const EPISODE_CACHE = 'mossgoblin-episodes';

/**
 * Whether a share came from this device (Android's share sheet, or this
 * app) and not from another site posting to /share: such a post could
 * plant text a later Claude would read (review on #98).
 */
function fromThisDevice(request) {
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return false;
  if (!request.referrer || request.referrer === 'about:client') return true;
  const from = new URL(request.referrer);
  // An app's referrer (android-app://...) is this device, not a site.
  if (from.protocol !== 'http:' && from.protocol !== 'https:') return true;
  return from.origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share') return;
  event.stopImmediatePropagation();
  event.respondWith(
    (async () => {
      if (!fromThisDevice(event.request)) return Response.redirect('/', 303);
      let form;
      try {
        form = await event.request.formData();
      } catch {
        // A body that does not parse: open the app all the same.
        return Response.redirect('/?shared=lost', 303);
      }
      const params = new URLSearchParams();
      for (const key of ['title', 'text', 'url']) {
        const value = form.get(key);
        if (typeof value === 'string' && value.trim()) params.set(key, value);
      }
      const files = form.getAll('files').filter((f) => typeof f !== 'string' && f.size > 0);
      if (files.length) {
        const cache = await caches.open(SHARE_CACHE);
        const stamp = Date.now();
        await Promise.all(
          files.map((file, i) =>
            cache.put(
              `/share-inbox/${stamp}-${i}`,
              new Response(file, {
                headers: {
                  'content-type': file.type || 'application/octet-stream',
                  'x-file-name': encodeURIComponent(file.name || 'shared'),
                },
              }),
            ),
          ),
        );
        params.set('shared', String(files.length));
        return Response.redirect(`/?${params}`, 303);
      }
      const stamp = Date.now();
      if (params.toString().length <= MAX_SHARE_QUERY) {
        params.set('at', String(stamp));
        return Response.redirect(`/share?${params}`, 303);
      }
      try {
        const cache = await caches.open(SHARE_WORDS_CACHE);
        await dropOldWords(cache, stamp);
        const words = {
          title: params.get('title') || '',
          text: params.get('text') || '',
          url: params.get('url') || '',
        };
        await cache.put(
          `/share-words/${stamp}`,
          new Response(JSON.stringify(words), { headers: { 'content-type': 'application/json' } }),
        );
        return Response.redirect(`/share?stash=${stamp}&at=${stamp}`, 303);
      } catch {
        // No cache to keep them in: as many as an address holds, and the
        // page says how many did not fit.
        return Response.redirect(`/share?${boundedShare(params, stamp)}`, 303);
      }
    })(),
  );
});

/** Stashed words older than a month were never filed: dropped. */
async function dropOldWords(cache, now) {
  for (const request of await cache.keys()) {
    const stamp = Number(/\/share-words\/(\d+)$/.exec(new URL(request.url).pathname)?.[1]);
    if (!(now - stamp < SHARE_WORDS_MAX_AGE_MS)) await cache.delete(request);
  }
}

/**
 * The share's fields in a query of at most MAX_SHARE_QUERY characters,
 * with `at`: the text cut to fit, and `cut` its whole length, so the
 * page says so rather than losing words quietly. As `boundedShare` in
 * infra/worker/src/index.ts, for a share that reaches the Worker.
 */
function boundedShare(params, stamp) {
  const whole = params.get('text') || '';
  // No more of it than could ever fit is looked at (review on #271).
  const text = whole.slice(0, MAX_SHARE_QUERY);
  const base = new URLSearchParams();
  const title = params.get('title');
  const url = params.get('url');
  if (title) base.set('title', title.slice(0, 1000));
  if (url) base.set('url', url.slice(0, 4096));
  base.set('at', String(stamp));
  const fits = (n) => {
    const q = new URLSearchParams(base);
    q.set('text', text.slice(0, n));
    if (n < whole.length) q.set('cut', String(whole.length));
    return q.toString().length <= MAX_SHARE_QUERY;
  };
  if (text.length === whole.length && fits(text.length)) {
    base.set('text', text);
    return base.toString();
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
  base.set('cut', String(whole.length));
  return base.toString();
}

// A downloaded episode (#180): the app keeps the whole file in the
// episodes cache under its /api/episode link, and the player asks for
// byte ranges of it, so a hit is answered here, a slice of the cached
// file with 206 and Content-Range, offline too. A miss goes to the
// network (the Worker's proxy) as it would without this worker.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin || url.pathname !== '/api/episode') return;
  event.stopImmediatePropagation();
  event.respondWith(episode(event.request));
});

async function episode(request) {
  let hit;
  try {
    const cache = await caches.open(EPISODE_CACHE);
    hit = await cache.match(request.url, { ignoreVary: true });
  } catch {
    // No cache to read: the network, then.
  }
  if (!hit) return fetch(request);
  const type = hit.headers.get('content-type') || 'audio/mpeg';
  const range = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get('range') || '').trim());
  const file = await hit.blob();
  const size = file.size;
  const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  if (!range || (range[1] === '' && range[2] === '')) {
    return new Response(file, {
      status: 200,
      headers: { ...base, 'content-length': String(size) },
    });
  }
  let start;
  let end;
  if (range[1] === '') {
    // The last n bytes.
    start = Math.max(0, size - Number(range[2]));
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  }
  // A Blob's slice is read lazily, so a seek does not load the file.
  return new Response(file.slice(start, end + 1, type), {
    status: 206,
    headers: {
      ...base,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
    },
  });
}

importScripts('ngsw-worker.js');
