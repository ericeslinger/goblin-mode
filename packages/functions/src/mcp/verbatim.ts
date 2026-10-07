// Split and merge move the gardener's text without rewording it
// (CLAUDE.md, Invariants). These checks are what make that true.

/**
 * Checks that `parts` are `body` cut into pieces, in order, with only
 * whitespace between them; returns each part trimmed, or why not.
 */
export function cutsOf(body: string, parts: readonly string[]): string[] | string {
  const trimmed = parts.map((p) => p.trim());
  if (trimmed.some((p) => !p)) return 'every part needs text';
  let pos = 0;
  for (const [i, part] of trimmed.entries()) {
    const at = body.indexOf(part, pos);
    if (at < 0 || body.slice(pos, at).trim()) {
      return `part ${i + 1} is not the next piece of the note word for word`;
    }
    pos = at + part.length;
  }
  if (body.slice(pos).trim()) return 'the parts leave out the end of the note';
  return trimmed;
}

/** Bodies one after another, each whole, a blank line between. */
export function joined(bodies: readonly string[]): string {
  return bodies.map((b) => b.trim()).join('\n\n');
}
