// Context for Claude (#113, Eric 2026-10-10): one note of kind `context`
// that Eric and Claude both edit, given to Claude on every connection.

/** The context note's id: derived, so every device names the same note. */
export const CONTEXT_ID = 'context';

/** What Claude is given, at most; the app shows how close the note is. */
export const CONTEXT_MAX = 4_000;

/**
 * The context as Claude gets it: the note's text, trimmed, cut at
 * `CONTEXT_MAX` characters with a line saying so.
 */
export function contextForClaude(body: string): string {
  const text = body.trim();
  if (text.length <= CONTEXT_MAX) return text;
  return `${text.slice(0, CONTEXT_MAX).trimEnd()}\n[cut at ${CONTEXT_MAX} characters]`;
}
