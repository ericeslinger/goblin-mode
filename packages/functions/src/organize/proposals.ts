// Claude's nightly organize routine (#35) hands its suggestions to
// `suggest_changes`, which keeps only those the organize tools would
// carry out: real, live notes, links not already there, names that
// reach their note, and nothing proposed before. What survives is
// stored for the gardener to accept.
import { parseNote, wikiLinkTargets } from '@mossgoblin/editor/grammar';
import {
  type ConceptType,
  type Proposal,
  type Touched,
  nameIndex,
  normalizeName,
  resolveLinks,
} from '@mossgoblin/schema';

/** A suggestion as Claude makes it, before any checks. */
export type RawProposal =
  | { kind: 'link'; from: string; to: string[]; reason: string }
  | { kind: 'merge'; ids: string[]; title?: string; reason: string }
  | { kind: 'refile'; id: string; type?: ConceptType; synonyms?: string[]; reason: string };

/** A stored note, as the checks need it. */
export interface GardenNote {
  id: string;
  kind: string;
  title: string;
  body: string;
  synonyms?: string[];
  conceptType?: string;
  archived?: boolean;
}

/** The most suggestions one round adds, and the most left open at once. */
export const PER_ROUND = 10;
export const MAX_OPEN = 20;
const REASON_CHARS = 300;

/** A proposal minus what storing it adds (status, createdAt). */
export type Checked = Omit<Proposal, 'status' | 'createdAt'>;

const linkable = (name: string) => !/\[\[|\]\]|\||\n/.test(name) && name.trim() !== '';
const sorted = (ids: readonly string[]) => [...new Set(ids)].sort().join(',');

/** The same change, proposed again, has the same key. */
export function keyOf(p: RawProposal): string {
  switch (p.kind) {
    case 'link':
      return `link:${p.from}>${sorted(p.to)}`;
    case 'merge':
      return `merge:${sorted(p.ids)}`;
    case 'refile':
      return `refile:${p.id}:${p.type ?? ''}:${[...(p.synonyms ?? [])].map(normalizeName).sort()}`;
  }
}

/**
 * The suggestions worth showing, in Claude's order: each checked against
 * the garden as it is now, none already proposed (in `known` keys, any
 * status), at most `room` of them.
 */
export function checkProposals(
  raw: readonly RawProposal[],
  garden: readonly GardenNote[],
  known: ReadonlySet<string>,
  room: number,
): Checked[] {
  const byId = new Map(garden.map((n) => [n.id, n]));
  const live = (id: string) => {
    const n = byId.get(id);
    return n && !n.archived ? n : undefined;
  };
  const index = nameIndex(garden);
  const touched = (n: GardenNote): Touched => ({ id: n.id, title: n.title });
  const keys = new Set(known);
  const out: Checked[] = [];

  for (const p of raw) {
    if (out.length >= room) break;
    const reason = p.reason?.trim().slice(0, REASON_CHARS);
    if (!reason) continue;
    let checked: Checked | undefined;
    if (p.kind === 'link') {
      const from = live(p.from);
      if (!from) continue;
      const already = new Set(resolveLinks(wikiLinkTargets(parseNote(from.body)), index));
      const to = [...new Set(p.to)]
        .map(live)
        .filter((n): n is GardenNote => !!n && n.id !== from.id && !already.has(n.id))
        // Reachable by a name of its own, as link_notes needs.
        .filter((n) =>
          [n.title, ...(n.synonyms ?? [])].some(
            (name) => linkable(name) && index.get(normalizeName(name)) === n.id,
          ),
        );
      if (to.length === 0) continue;
      const fixed = { ...p, to: to.map((n) => n.id) };
      checked = { kind: 'link', reason, notes: [from, ...to].map(touched), key: keyOf(fixed) };
    } else if (p.kind === 'merge') {
      const notes = [...new Set(p.ids)].map(live);
      if (notes.length < 2 || notes.some((n) => !n || n.kind !== 'text')) continue;
      const title = p.title?.trim();
      checked = {
        kind: 'merge',
        reason,
        notes: (notes as GardenNote[]).map(touched),
        ...(title ? { title } : {}),
        key: keyOf(p),
      };
    } else if (p.kind === 'refile') {
      const concept = live(p.id);
      if (!concept || concept.kind !== 'concept') continue;
      const type = p.type && p.type !== (concept.conceptType ?? 'other') ? p.type : undefined;
      const have = new Set([concept.title, ...(concept.synonyms ?? [])].map(normalizeName));
      const synonyms: string[] = [];
      for (const raw of p.synonyms ?? []) {
        const name = raw.trim();
        const key = normalizeName(name);
        const owner = index.get(key);
        if (!key || have.has(key) || (owner && owner !== concept.id)) continue;
        have.add(key);
        synonyms.push(name);
      }
      if (!type && synonyms.length === 0) continue;
      const fixed = { ...p, type, synonyms };
      checked = {
        kind: 'refile',
        reason,
        notes: [touched(concept)],
        ...(type ? { conceptType: type } : {}),
        ...(synonyms.length ? { synonyms } : {}),
        key: keyOf(fixed),
      };
    }
    if (!checked || keys.has(checked.key)) continue;
    keys.add(checked.key);
    out.push(checked);
  }
  return out;
}
