/** Away this long or more and launch opens a fresh note. */
export const FRESH_NOTE_AFTER_MS = 5 * 60 * 1000;

/**
 * Decides whether launch (or returning to the app) opens a fresh note.
 * `hiddenAt` is when the app was last hidden, or undefined when it never
 * was (first run, cleared storage).
 */
export function shouldStartFreshNote(hiddenAt: number | undefined, now: number): boolean {
  if (hiddenAt === undefined || !Number.isFinite(hiddenAt)) return true;
  // A clock that moved backwards is treated as "just left".
  return now - hiddenAt >= FRESH_NOTE_AFTER_MS;
}
