const MAX_WORDS = 6;
const MAX_CHARS = 60;

/**
 * The fallback title: the first few words of the first non-empty line,
 * without markdown markers. Empty body gives an empty title.
 */
export function firstWordsTitle(body: string): string {
  const line = body
    .split('\n')
    .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/, '').trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  const words = line
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .split(/\s+/)
    .slice(0, MAX_WORDS);
  let title = words.join(' ');
  if (title.length > MAX_CHARS) title = title.slice(0, MAX_CHARS - 1).trimEnd() + '…';
  return title;
}

/** The first non-empty line, trimmed: what a title is keyed on. */
export function firstLine(body: string): string {
  return (
    body
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? ''
  );
}

/** Fewer words than this and the first words already are the title. */
export const TITLE_MIN_WORDS = 4;

/**
 * Whether a write should get a Claude title (Eric, 2026-10-06): the note
 * was just settled (its `settledAt` moved), it is long enough to need
 * one, and the title is not Eric's own. Times are epoch milliseconds.
 */
export function wantsClaudeTitle(
  before: { settledAt?: number } | undefined,
  after: { body: string; titleSource?: string; settledAt?: number },
): boolean {
  if (after.titleSource === 'user' || after.settledAt === undefined) return false;
  if (before?.settledAt === after.settledAt) return false;
  return after.body.split(/\s+/).filter(Boolean).length >= TITLE_MIN_WORDS;
}

/** A model's reply made into a title: one line, no quotes, bounded. */
export function cleanTitle(reply: string): string {
  let title = firstLine(reply);
  title = title
    .replace(/^title:\s*/i, '')
    .replace(/^["'“”‘’*_#]+|["'“”‘’*_.]+$/g, '')
    .trim();
  if (title.length > MAX_CHARS) title = title.slice(0, MAX_CHARS - 1).trimEnd() + '…';
  return title;
}
