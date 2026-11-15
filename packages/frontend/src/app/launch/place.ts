/**
 * The last place (#272, Eric, 2026-11-15): the screen open last on this
 * device, kept in localStorage so a launch after the app was closed or
 * killed can go back to it. The pure parts, read by CaptureService
 * (which note `/` shows) and LastPlaceService (everything else).
 */
export const LAST_PLACE_KEY = 'goblin.lastPlace';

/** Where on its screen the place was: the scroll, and for a note its caret. */
export interface Spot {
  /** Pixels scrolled from the top of the screen's scroller. */
  top?: number;
  /** A note's caret, as an offset into its text. */
  caret?: number;
  /** On `/`: the capture note shown, and whether it had been saved. */
  note?: string;
  saved?: boolean;
}

export interface LastPlace extends Spot {
  /** The URL as the router shows it, path and query. */
  url: string;
  /** An article's run through its shelf (#188), as the tab kept it. */
  visited?: string;
}

/** The modules a place can need. */
export type PlaceModule = 'kitchen' | 'reader' | 'podcasts';

const pathOf = (url: string) => url.split(/[?#]/, 1)[0];

/**
 * The URL to remember for one the router shows, or undefined for one
 * not to come back to: a share (it was filed or let go), sign-in pages,
 * and `/` while it still carries a share or an old link to tidy (the
 * tidied `/` is remembered). A note is remembered by its path alone: a
 * reminder's `?from=reminder` would make a second entry.
 */
export function keptUrl(url: string): string | undefined {
  // Only this app's own addresses: a router URL starts with one slash.
  if (!url.startsWith('/') || url.startsWith('//')) return undefined;
  const path = pathOf(url);
  if (/^\/(share|dev-sign-in|oauth)(\/|$)/.test(path)) return undefined;
  if (path === '/') return url === '/' ? '/' : undefined;
  if (/^\/n\/[^/]+$/.test(path)) return path;
  return url;
}

/** The note a place shows at its own URL, `/n/<id>`. */
export function noteOf(url: string): string | undefined {
  const id = /^\/n\/([^/?#]+)$/.exec(pathOf(url))?.[1];
  if (!id) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/** The module a place belongs to; Downloads serves the Reader and Podcasts both. */
export function moduleOf(url: string): PlaceModule | undefined {
  const path = pathOf(url);
  if (path === '/reader/downloads') return undefined;
  const top = /^\/(kitchen|reader|podcasts)(\/|$)/.exec(path)?.[1];
  return top as PlaceModule | undefined;
}

/** A stored place, if it reads as one this app can go back to. */
export function readPlace(value: unknown): LastPlace | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const place = value as Partial<LastPlace>;
  if (typeof place.url !== 'string' || keptUrl(place.url) !== place.url) return undefined;
  const num = (n: unknown) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
  const top = num(place.top);
  const caret = num(place.caret);
  return {
    url: place.url,
    ...(top ? { top } : {}),
    ...(caret !== undefined ? { caret } : {}),
    ...(typeof place.note === 'string' && place.note ? { note: place.note } : {}),
    ...(place.saved === true ? { saved: true } : {}),
    ...(typeof place.visited === 'string' ? { visited: place.visited } : {}),
  };
}
