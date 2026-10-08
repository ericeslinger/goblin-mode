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
/** Templates are listed in Settings, not among the notes (#38). */
const note = (n: NoteRecord) => live(n) && n.kind !== 'template';
const concept = (n: NoteRecord) => live(n) && n.kind === 'concept';

/** Whether a note shows under a lens. Order is the notes' own (newest first). */
export function inLens(lens: LensId, n: NoteRecord): boolean {
  switch (lens) {
    case 'recent':
      // Notes with something written; empty stub concepts would be noise.
      return note(n) && !!n.body.trim();
    case 'concepts':
      return concept(n);
    case 'people':
      return concept(n) && n.conceptType === 'person';
    case 'projects':
      return concept(n) && n.conceptType === 'project';
    case 'tags':
      return note(n) && (n.tags?.length ?? 0) > 0;
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

/**
 * Projects as a tree (#41): each with how deep it sits, children under
 * their parent in name order. A project whose parent is not in the list
 * (filtered out, archived or gone) starts a tree of its own.
 */
export function projectTree(
  projects: readonly NoteRecord[],
): { note: NoteRecord; depth: number }[] {
  const ids = new Set(projects.map((p) => p.id));
  const byName = (a: NoteRecord, b: NoteRecord) => a.title.localeCompare(b.title);
  const under = new Map<string, NoteRecord[]>();
  const roots: NoteRecord[] = [];
  for (const p of projects) {
    if (p.parent && p.parent !== p.id && ids.has(p.parent)) {
      under.set(p.parent, [...(under.get(p.parent) ?? []), p]);
    } else roots.push(p);
  }
  const out: { note: NoteRecord; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (p: NoteRecord, depth: number) => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    out.push({ note: p, depth });
    for (const c of (under.get(p.id) ?? []).sort(byName)) walk(c, depth + 1);
  };
  for (const r of roots.sort(byName)) walk(r, 0);
  // A loop of parents (written elsewhere) has no root: list it flat.
  for (const p of [...projects].sort(byName)) walk(p, 0);
  return out;
}
