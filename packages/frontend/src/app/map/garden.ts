/** What the garden and timeline layouts need of a note. */
export interface MapNote {
  id: string;
  title: string;
  kind: string;
  links: readonly string[];
  archived?: boolean;
  body: string;
  createdAt?: number;
  updatedAt?: number;
}

/** A concept's bed: the concept and the notes planted around it. */
export interface Bed {
  /** The concept's id, or '' for notes that link no concept yet. */
  id: string;
  title: string;
  notes: MapNote[];
}

/**
 * The garden (#33): every live concept is a bed, most-linked first, and
 * each note with text is planted in the bed of the first concept it
 * links (by that order), so it appears once. Notes that link no concept
 * go in a last bed with no concept.
 */
export function beds(notes: readonly MapNote[]): Bed[] {
  const live = notes.filter((n) => !n.archived);
  const concepts = live.filter((n) => n.kind === 'concept');
  const writings = live.filter(
    (n) => n.kind !== 'concept' && n.kind !== 'template' && n.body.trim(),
  );
  const count = new Map<string, number>();
  for (const n of writings)
    for (const id of new Set(n.links)) count.set(id, (count.get(id) ?? 0) + 1);
  const order = [...concepts].sort(
    (a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0) || a.title.localeCompare(b.title),
  );
  const rank = new Map(order.map((c, i) => [c.id, i]));
  const byBed = new Map<string, MapNote[]>(order.map((c) => [c.id, []]));
  const loose: MapNote[] = [];
  for (const n of writings) {
    const home = n.links
      .filter((id) => rank.has(id))
      .sort((a, b) => rank.get(a)! - rank.get(b)!)[0];
    if (home) byBed.get(home)!.push(n);
    else loose.push(n);
  }
  const result: Bed[] = order.map((c) => ({ id: c.id, title: c.title, notes: byBed.get(c.id)! }));
  if (loose.length) result.push({ id: '', title: 'Not linked yet', notes: loose });
  return result;
}

/** Where a bed sits in a grid of `cell`-sized squares, `cols` wide. */
export function bedGrid(count: number, cell = 240): { x: number; y: number; cols: number }[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  return Array.from({ length: count }, (_, i) => ({
    x: (i % cols) * cell + cell / 2,
    y: Math.floor(i / cols) * cell + cell / 2,
    cols,
  }));
}

/** A note's spot around its bed's center: a ring, then a wider ring. */
export function plant(i: number, cx: number, cy: number): { x: number; y: number } {
  const ring = i < 8 ? 0 : 1;
  const k = ring === 0 ? i : i - 8;
  const n = ring === 0 ? 8 : 12;
  const r = ring === 0 ? 55 : 90;
  const a = (2 * Math.PI * k) / n - Math.PI / 2;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** A lane on the timeline: a concept and its notes, oldest first. */
export interface Lane {
  id: string;
  title: string;
  notes: { note: MapNote; at: number }[];
}

/**
 * The timeline (#33): the garden's beds as lanes (up to `max`, the rest
 * folded into the last), each note at when it was made. `only` keeps
 * one concept's lane, holding every note that links it, not just the
 * ones planted in its bed.
 */
export function lanes(notes: readonly MapNote[], max = 6, only?: string): Lane[] {
  const at = (n: MapNote) => n.createdAt ?? n.updatedAt ?? 0;
  let list = beds(notes);
  if (only !== undefined)
    list = list
      .filter((b) => b.id === only)
      .map((b) => ({
        ...b,
        notes: notes.filter(
          (n) =>
            !n.archived &&
            n.kind !== 'concept' &&
            n.kind !== 'template' &&
            n.body.trim() &&
            n.links.includes(only),
        ),
      }));
  if (list.length > max) {
    const rest = list.slice(max - 1);
    list = [
      ...list.slice(0, max - 1),
      { id: '*', title: 'Everything else', notes: rest.flatMap((b) => b.notes) },
    ];
  }
  return list.map((b) => ({
    id: b.id,
    title: b.title,
    notes: b.notes.map((note) => ({ note, at: at(note) })).sort((a, b) => a.at - b.at),
  }));
}
