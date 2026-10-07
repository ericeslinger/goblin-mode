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
 * (letters and digits in any script, words joined by hyphens). When the
 * slug does not spell the name exactly (punctuation, accents, a long
 * name cut short), a hash of the name follows, so `C`, `C++` and `C#`,
 * or `a b` and `a-b`, stay three and two concepts. Safe as a Firestore
 * document id and in a URL path segment.
 */
export function conceptId(name: string): string {
  const normal = normalizeName(name);
  const slug = normal
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  if (!slug) return CONCEPT_PREFIX + hash(normal);
  const exact = slug.replace(/-/g, ' ') === normal;
  return CONCEPT_PREFIX + (exact ? slug : `${slug}-${hash(normal)}`);
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

/** One autocomplete choice: the name to insert and what it is. */
export interface LinkSuggestion {
  name: string;
  /** 'person', 'project', 'concept', 'note', or 'new' for a name to make. */
  kind: string;
}

/**
 * Names a `[[` can complete to, best first: names that start with the
 * query before names that contain it, concepts (by title or synonym)
 * before notes, then shorter names. A concept found by a synonym is
 * offered by its title. A query nothing matches exactly is
 * offered as a new concept at the end. Archived notes are left out.
 */
export function suggestLinks(
  query: string,
  notes: readonly (NamedNote & { conceptType?: string })[],
  limit = 8,
): LinkSuggestion[] {
  const q = normalizeName(query);
  const scored: { name: string; kind: string; rank: number }[] = [];
  const seen = new Set<string>();
  /** A note matches by its title, or a concept by any of its names. */
  const consider = (title: string, names: string[], kind: string, concept: boolean) => {
    const key = normalizeName(title);
    if (!key || seen.has(key)) return;
    const at = names.map((n) => normalizeName(n).indexOf(q)).filter((i) => i >= 0);
    if (at.length === 0) return;
    seen.add(key);
    for (const n of names) seen.add(normalizeName(n));
    scored.push({ name: title, kind, rank: (at.includes(0) ? 0 : 2) + (concept ? 0 : 1) });
  };
  const live = notes.filter((n) => !n.archived);
  for (const n of live.filter((n) => n.kind === 'concept')) {
    const kind = n.conceptType && n.conceptType !== 'other' ? n.conceptType : 'concept';
    consider(n.title, [n.title, ...(n.synonyms ?? [])], kind, true);
  }
  for (const n of live.filter((n) => n.kind !== 'concept'))
    consider(n.title, [n.title], 'note', false);
  scored.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length);
  const found: LinkSuggestion[] = scored.slice(0, limit).map(({ name, kind }) => ({ name, kind }));
  if (q && !seen.has(q)) found.push({ name: query.trim(), kind: 'new' });
  return found;
}

/** What the link graph needs of a note: its id and the ids it links to. */
export interface LinkedNote {
  id: string;
  archived?: boolean;
  links: readonly string[];
}

/** Live notes that link to `id`, in the order given (newest first). */
export function backlinks<T extends LinkedNote>(id: string, notes: readonly T[]): T[] {
  return notes.filter((n) => !n.archived && n.id !== id && n.links.includes(id));
}

/**
 * Concepts that share notes with `id`: every other concept linked from a
 * note that links to `id`, most shared first (then by id, for a stable
 * order). Concept ids carry CONCEPT_PREFIX; `isConcept` can widen that
 * to concepts with other ids.
 */
export function oftenTogether(
  id: string,
  notes: readonly LinkedNote[],
  limit = 6,
  isConcept: (id: string) => boolean = (other) => other.startsWith(CONCEPT_PREFIX),
): { id: string; shared: number }[] {
  const counts = new Map<string, number>();
  for (const n of backlinks(id, notes)) {
    for (const other of new Set(n.links)) {
      if (other === id || other === n.id || !isConcept(other)) continue;
      counts.set(other, (counts.get(other) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([other, shared]) => ({ id: other, shared }))
    .sort((a, b) => b.shared - a.shared || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * The sentence around a span of a note's text (a link), on its line,
 * trimmed of list and heading marks, at most `max` characters.
 */
export function sentenceAround(body: string, start: number, end: number, max = 160): string {
  const lineStart = body.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = body.indexOf('\n', end);
  const line = body.slice(lineStart, lineEnd < 0 ? body.length : lineEnd);
  const at = start - lineStart;
  const stop = /[.!?](\s|$)/g;
  let from = 0;
  let to = line.length;
  for (const m of line.matchAll(stop)) {
    const after = m.index + 1;
    if (after <= at) from = after;
    else if (m.index >= at + (end - start) - 1) {
      to = after;
      break;
    }
  }
  const text = line
    .slice(from, to)
    .replace(/^\s*([-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+|>\s*)/, '')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A note in a neighborhood: how many links away from the center. */
export interface Neighbor {
  id: string;
  hop: 0 | 1 | 2;
  /** For hop 2: the hop-1 note it was reached through. */
  via?: string;
}

/**
 * The notes around `id`, two links out in either direction (a link or a
 * backlink), live notes only, at most `limits` per ring, closest and
 * most-connected first. Edges are the links among the notes shown.
 */
export function neighborhood(
  id: string,
  notes: readonly LinkedNote[],
  limits: { hop1: number; hop2: number } = { hop1: 16, hop2: 32 },
): { nodes: Neighbor[]; edges: [string, string][] } {
  const live = notes.filter((n) => !n.archived);
  const known = new Set(live.map((n) => n.id));
  const around = new Map<string, Set<string>>();
  const touch = (a: string, b: string) => {
    if (a === b || !known.has(a) || !known.has(b)) return;
    around.set(a, (around.get(a) ?? new Set()).add(b));
    around.set(b, (around.get(b) ?? new Set()).add(a));
  };
  for (const n of live) for (const to of n.links) touch(n.id, to);
  const degree = (n: string) => around.get(n)?.size ?? 0;
  const byDegree = (a: string, b: string) => degree(b) - degree(a) || a.localeCompare(b);

  const ring1 = [...(around.get(id) ?? [])].sort(byDegree).slice(0, limits.hop1);
  const shown = new Set([id, ...ring1]);
  const ring2: Neighbor[] = [];
  for (const via of ring1) {
    for (const next of [...(around.get(via) ?? [])].sort(byDegree)) {
      if (shown.has(next) || ring2.length >= limits.hop2) continue;
      shown.add(next);
      ring2.push({ id: next, hop: 2, via });
    }
  }
  const nodes: Neighbor[] = [
    { id, hop: 0 },
    ...ring1.map((n) => ({ id: n, hop: 1 as const })),
    ...ring2,
  ];
  const edges: [string, string][] = [];
  for (const n of live) {
    if (!shown.has(n.id)) continue;
    for (const to of new Set(n.links)) {
      if (to !== n.id && shown.has(to)) edges.push([n.id, to]);
    }
  }
  return { nodes: known.has(id) ? nodes : [], edges: known.has(id) ? edges : [] };
}
