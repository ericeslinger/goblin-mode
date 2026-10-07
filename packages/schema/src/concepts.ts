// Concepts and links (#28, M2): how a `[[name]]` becomes a note id.
//
// A concept is a note with kind 'concept' (a person, a project, other),
// a title and synonyms. Its id is derived from its name, so two devices
// that link the same new name while offline make the same concept, and
// a link resolves without a lookup. Renaming keeps the id and adds the
// old name as a synonym, so old links still land.
//
// Pure: the markdown parsing that finds `[[...]]` lives in
// @mossgoblin/editor/grammar (wikiLinkTargets); callers pass the targets.

/** How names compare: Unicode-normalized, case-folded, spaces collapsed. */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Concept ids start with this; Firestore auto ids never contain '-'. */
export const CONCEPT_PREFIX = 'c-';
const MAX_SLUG = 100;

/** FNV-1a, for names with no letters or digits to slug. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The id of the concept a name makes: `c-` and a slug of the name
 * (accents dropped, letters and digits in any script kept, the rest
 * folded to single hyphens). Safe as a Firestore document id and in a
 * URL path segment.
 */
export function conceptId(name: string): string {
  const slug = normalizeName(name)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return CONCEPT_PREFIX + (slug || hash(normalizeName(name)));
}

/** What the index needs of a note. */
export interface NamedNote {
  id: string;
  title: string;
  kind?: string;
  synonyms?: readonly string[];
  archived?: boolean;
}

/**
 * Names to ids, for resolving links: a concept's title and synonyms,
 * then other notes' titles. A concept wins over a note with the same
 * title, and the first of two equal names wins. Archived notes are left
 * out, so a link follows a merge to the note that replaced it.
 */
export function nameIndex(notes: readonly NamedNote[]): Map<string, string> {
  const index = new Map<string, string>();
  const add = (name: string, id: string) => {
    const key = normalizeName(name);
    if (key && !index.has(key)) index.set(key, id);
  };
  const live = notes.filter((n) => !n.archived);
  for (const n of live.filter((n) => n.kind === 'concept')) {
    add(n.title, n.id);
    for (const s of n.synonyms ?? []) add(s, n.id);
  }
  for (const n of live.filter((n) => n.kind !== 'concept')) add(n.title, n.id);
  return index;
}

/**
 * The ids a note's links point at, in order, without repeats. A name
 * nothing answers to points at the concept it would make.
 */
export function resolveLinks(targets: readonly string[], index: Map<string, string>): string[] {
  const ids = targets.map((t) => index.get(normalizeName(t)) ?? conceptId(t));
  return [...new Set(ids)];
}
