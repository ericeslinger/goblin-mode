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
