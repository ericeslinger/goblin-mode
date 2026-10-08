// The feelings journal (#40): entries from a template with a Moods line.
// Moods are concepts of type mood (Eric, 2026-10-08), linked from that
// line, so a mood's page lists every entry that named it.

/** A Moods line, plural, as a list item or not, the label bold or not. */
const MOODS_LINE = /^[ \t]*(?:[-*+][ \t]+)?\*?moods\*?[ \t]*:\*?[ \t]*(.*)$/i;
const LINK = /\[\[([^[\]\n|]+)(?:\|[^[\]\n]*)?\]\]/g;

/** Whether `line` is a Moods line; the text after the colon if so. */
export function moodLine(line: string): string | undefined {
  return MOODS_LINE.exec(line)?.[1];
}

/** The names linked on a body's Moods lines: these are moods. */
export function moodTargets(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const rest = moodLine(line);
    if (rest === undefined) continue;
    for (const m of rest.matchAll(LINK)) out.push(m[1].trim());
  }
  return out.filter(Boolean);
}

/** Every mood a body names on its Moods lines, linked or plain, once each. */
export function moodsOf(body: string): string[] {
  const out = new Map<string, string>();
  for (const line of body.split('\n')) {
    const rest = moodLine(line);
    if (rest === undefined) continue;
    for (const part of rest.split(',')) {
      const name = part
        .replace(LINK, (_, target: string) => target)
        .replace(/[[\]*_]/g, '')
        .trim();
      if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), name);
    }
  }
  return [...out.values()];
}

/** The feelings journal template: a new entry each time. */
export const FEELINGS_TEMPLATE = [
  'Feelings',
  '',
  'Moods: ',
  '',
  '## What’s here',
  '',
  '## What helped',
  '',
  '## One small thing',
  '',
  '## Instructions for Claude',
  '',
  'A feelings journal entry. Moods go on the Moods line as [[links]], separated by commas;',
  'a new one becomes a concept of type mood (refile it so if it is not). Never reword what',
  'Eric wrote. Asked to look back over a stretch of days, quote entries word for word and',
  'say which moods came up most.',
  '',
].join('\n');

/** When the journal asks to be filled in: breakfast, lunch and dinner. */
export const FEELINGS_TIMES = [
  { time: '08:00', text: 'Feelings journal: breakfast' },
  { time: '12:30', text: 'Feelings journal: lunch' },
  { time: '18:30', text: 'Feelings journal: dinner' },
] as const;

/**
 * Mood names matching `query`, for a Moods line: those starting with it
 * first, then those containing it, each group in the order given (the
 * app's notes are newest first, so recent moods lead).
 */
export function suggestMoods(
  query: string,
  notes: readonly { kind?: string; conceptType?: string; title: string; archived?: boolean }[],
  limit = 8,
): string[] {
  const q = query.trim().toLowerCase();
  const moods = notes.filter(
    (n) => n.kind === 'concept' && n.conceptType === 'mood' && !n.archived,
  );
  const at = (n: { title: string }) => n.title.toLowerCase().indexOf(q);
  return [...moods.filter((n) => at(n) === 0), ...moods.filter((n) => at(n) > 0)]
    .slice(0, limit)
    .map((n) => n.title);
}
