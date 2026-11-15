/**
 * Where the visited articles are kept for this tab, through a reload
 * (#188). A module of its own so the last place (#272), which carries
 * them across an app closed and opened again, can name it without
 * loading the Reader.
 */
export const VISITED_KEY = 'goblin.reader.visited';
