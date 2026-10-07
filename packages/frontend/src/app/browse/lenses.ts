import type { NoteRecord } from '../notes/notes.service';

/** Ways to look at the garden (#31); each has its own URL, /browse/<id>. */
export const LENSES = [
  { id: 'recent', label: 'Recent' },
  { id: 'concepts', label: 'Concepts' },
  { id: 'people', label: 'People' },
  { id: 'projects', label: 'Projects' },
  { id: 'tags', label: 'Tags' },
  { id: 'archived', label: 'Archived' },
] as const;
export type LensId = (typeof LENSES)[number]['id'];

export function lensId(value: string | null | undefined): LensId {
  return LENSES.find((l) => l.id === value)?.id ?? 'recent';
}

const live = (n: NoteRecord) => !n.archived;
const concept = (n: NoteRecord) => live(n) && n.kind === 'concept';

/** Whether a note shows under a lens. Order is the notes' own (newest first). */
export function inLens(lens: LensId, n: NoteRecord): boolean {
  switch (lens) {
    case 'recent':
      // Notes with something written; empty stub concepts would be noise.
      return live(n) && !!n.body.trim();
    case 'concepts':
      return concept(n);
    case 'people':
      return concept(n) && n.conceptType === 'person';
    case 'projects':
      return concept(n) && n.conceptType === 'project';
    case 'tags':
      return live(n) && (n.tags?.length ?? 0) > 0;
    case 'archived':
      return !!n.archived;
  }
}

/** Notes grouped by tag, tags in alphabetical order; a note can be in several. */
export function byTag(notes: readonly NoteRecord[]): { tag: string; notes: NoteRecord[] }[] {
  const groups = new Map<string, NoteRecord[]>();
  for (const n of notes) {
    for (const tag of new Set(n.tags ?? [])) groups.set(tag, [...(groups.get(tag) ?? []), n]);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, list]) => ({ tag, notes: list }));
}
