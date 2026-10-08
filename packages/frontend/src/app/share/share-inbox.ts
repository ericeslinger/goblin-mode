import { InjectionToken } from '@angular/core';

/** Where sw.js keeps files shared from another app (#46). */
export const SHARE_CACHE = 'mossgoblin-share';

/** How long shared files wait for a note: older ones are dropped. */
export const SHARE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Files shared in and waiting for the page; taking them empties the inbox. */
export interface ShareInbox {
  take(): Promise<File[]>;
}

export const SHARE_INBOX = new InjectionToken<ShareInbox>('share-inbox', {
  providedIn: 'root',
  factory: () => ({
    async take() {
      if (!('caches' in globalThis)) return [];
      const cache = await caches.open(SHARE_CACHE);
      const files: File[] = [];
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        await cache.delete(request);
        // Kept at /share-inbox/<ms>-<n>: one from long ago is not this share.
        const stamp = Number(/\/share-inbox\/(\d+)-/.exec(request.url)?.[1]);
        if (!response || !(Date.now() - stamp < SHARE_MAX_AGE_MS)) continue;
        const blob = await response.blob();
        const name = decodeURIComponent(response.headers.get('x-file-name') ?? 'shared');
        files.push(new File([blob], name, { type: blob.type }));
      }
      return files;
    },
  }),
});
