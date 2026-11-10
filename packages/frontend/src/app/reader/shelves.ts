// The Reader's special shelves (#162) and what a list shows, apart
// from the services so both can import them without a cycle (#185).

/** The special folders. */
export const ALL = 'all';
export const SAVED = 'saved';
/**
 * The special folders' names, which no folder of feeds may take in any
 * letter case (#185): such a folder is renamed by `cleanFolder`.
 * Podcasts was a shelf until #245 (2026-11-10) made it a module of its
 * own; its name stays taken, so a Reader folder never reads as it.
 */
export const RESERVED_FOLDERS: readonly string[] = [ALL, SAVED, 'podcasts'];

/** A list the reader shows: a folder, one feed, everything, or what is saved. */
export type Shelf2 = { kind: 'folder'; name: string } | { kind: 'feed'; id: string };

/** A shelf as the article's `in` query parameter carries it. */
export function shelfParam(shelf: Shelf2): string {
  return shelf.kind === 'feed' ? `s:${shelf.id}` : `f:${shelf.name}`;
}
