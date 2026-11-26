// Public copies of notes (2026-11-26, Eric): a note or a recipe shared
// as a link that only someone sent it can find. The link's secret part
// is the share's id, made here on the device; DESIGN.md, Sharing a
// public copy.
// Nothing imported: the Worker reads this file on its own.

/** Random bytes in a share id: 192 bits, past the 128 asked for. */
export const SHARE_ID_BYTES = 24;
/** Characters in a share id: base64url of SHARE_ID_BYTES, no padding. */
export const SHARE_ID_LENGTH = 32;
/** A share id's shape, as the rules and the Worker check it. */
export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
/** The public page's path, before the id. */
export const SHARE_PATH = '/s/';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A new share id: SHARE_ID_BYTES from `fill` (crypto.getRandomValues in
 * the app) as base64url, 32 characters. Never derived from the note,
 * its title or the owner, and never the 20-character auto id, whose
 * alphabet of 62 gives about 119 bits. Firestore keeps ids of the form
 * `__...__` for itself; such a draw (about one in 17 million) is drawn
 * again.
 */
export function newShareId(fill: (bytes: Uint8Array<ArrayBuffer>) => void): string {
  for (;;) {
    const bytes = new Uint8Array(SHARE_ID_BYTES);
    fill(bytes);
    let id = '';
    // 24 bytes are 8 groups of 3, each 4 characters: no padding.
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      id += BASE64URL[(n >> 18) & 63] + BASE64URL[(n >> 12) & 63];
      id += BASE64URL[(n >> 6) & 63] + BASE64URL[n & 63];
    }
    if (!/^__.*__$/.test(id)) return id;
  }
}

/** Whether `id` has a share id's shape; checked before anything is fetched. */
export function isShareId(id: unknown): id is string {
  return typeof id === 'string' && SHARE_ID_PATTERN.test(id);
}

/**
 * What a note of `kind` is shared as, or undefined when it cannot be
 * shared: only plain notes and recipes (2026-11-26). A concept, a
 * template, the kitchen's own notes and a clipping (a page's text, not
 * Eric's) are not offered.
 */
export function shareKindOf(kind: string): 'note' | 'recipe' | undefined {
  if (kind === 'text') return 'note';
  if (kind === 'recipe') return 'recipe';
  return undefined;
}

/** A recipe's source link as a share keeps it: http or https only, else none. */
export function shareSource(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return url.length <= 4096 ? url : undefined;
  } catch {
    return undefined;
  }
}
