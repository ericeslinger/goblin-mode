/**
 * Search as the app and Claude's tools share it: case-insensitive, every
 * word must appear in the title, body or synonyms.
 */
export function matchesSearch(
  note: { title: string; body: string; synonyms?: string[] },
  search: string,
): boolean {
  const haystack = [note.title, note.body, ...(note.synonyms ?? [])].join('\n').toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}
