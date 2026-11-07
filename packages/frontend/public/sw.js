// The app's service worker: the share target (#46), downloaded podcast
// episodes (#180), then Angular's.
//
// A share from another app is a POST to /share (manifest share_target).
// The files go into a cache the page reads at /?shared=<n>; the title,
// text and link ride along in the query. Listened for before Angular's
// worker loads, which would answer every fetch itself.
const SHARE_CACHE = 'mossgoblin-share';
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
      }
      return Response.redirect(`/?${params}`, 303);
    })(),
  );
});

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
