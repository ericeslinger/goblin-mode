// The Reader's special shelves (#162, #178) and what a list shows, apart
// from the services so both can import them without a cycle (#185).

/** The special folders. */
export const ALL = 'all';
export const SAVED = 'saved';
/** The episodes of every podcast feed (#178), shown once one is followed. */
export const PODCASTS = 'podcasts';
/**
 * The special folders' names, which no folder of feeds may take in any
 * letter case (#185): such a folder is renamed by `cleanFolder`.
 */
export const RESERVED_FOLDERS: readonly string[] = [ALL, SAVED, PODCASTS];

/** A list the reader shows: a folder, one feed, everything, or what is saved. */
export type Shelf2 = { kind: 'folder'; name: string } | { kind: 'feed'; id: string };
