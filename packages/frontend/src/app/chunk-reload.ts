import type { NavigationError } from '@angular/router';

/** Loads an address afresh; a seam for specs. */
export const loadAfresh = { run: (url: string) => location.assign(url) };

const KEY = 'goblin.chunkReload';
/** One reload for an address in this long: a chunk truly gone must not loop. */
const ONCE_IN_MS = 60_000;

/**
 * Whether an error is a lazy route's code failing to load, as each
 * browser words it: Chrome, Firefox, Safari.
 */
export function isChunkLoadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
    message,
  );
}

/**
 * The router's navigation error handler (2026-11-26, #312). A screen's
 * code is loaded when the screen is first opened; if that load fails
 * (cancelled by the browser, or a file a deploy has since replaced) the
 * router gives up, puts the address back and draws nothing, and the app
 * stayed blank until reloaded by hand: a journey caught it at
 * `/settings`, the fetch cancelled 0.03 ms after it was sent. So the
 * address asked for is loaded afresh, once: a second failure for the
 * same address within a minute is left alone, and so is one that
 * cannot be remembered, so a file truly gone never loops.
 */
export function reloadOnChunkError(
  error: Pick<NavigationError, 'error' | 'url'>,
  storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage,
  now = Date.now(),
): void {
  if (!isChunkLoadError(error.error)) return;
  try {
    const last = JSON.parse(storage.getItem(KEY) ?? 'null') as { url?: string; at?: number } | null;
    if (last?.url === error.url && now - (last.at ?? 0) < ONCE_IN_MS) return;
    storage.setItem(KEY, JSON.stringify({ url: error.url, at: now }));
  } catch {
    return;
  }
  loadAfresh.run(error.url);
}
