// The app's service worker: the share target (#46), then Angular's.
//
// A share from another app is a POST to /share (manifest share_target).
// The files go into a cache the page reads at /?shared=<n>; the title,
// text and link ride along in the query. Listened for before Angular's
// worker loads, which would answer every fetch itself.
const SHARE_CACHE = 'mossgoblin-share';

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

importScripts('ngsw-worker.js');
