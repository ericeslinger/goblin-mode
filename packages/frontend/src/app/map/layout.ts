import type { Neighbor } from '@mossgoblin/schema';

export interface Placed extends Neighbor {
  x: number;
  y: number;
}

/**
 * A radial layout in a `size` square: the center in the middle, the
 * notes one link away on an inner ring, and each note two links away
 * near the inner note it was reached through. Deterministic, so the map
 * looks the same each time it is opened.
 */
export function radial(nodes: readonly Neighbor[], size = 600): Placed[] {
  const c = size / 2;
  const inner = size * 0.25;
  const outer = size * 0.42;
  const ring1 = nodes.filter((n) => n.hop === 1);
  const sector = (2 * Math.PI) / Math.max(ring1.length, 1);
  const angle = new Map(ring1.map((n, i) => [n.id, i * sector - Math.PI / 2]));
  const at = (r: number, a: number) => ({ x: c + r * Math.cos(a), y: c + r * Math.sin(a) });

  const placed: Placed[] = [];
  for (const n of nodes) {
    if (n.hop === 0) placed.push({ ...n, x: c, y: c });
    if (n.hop === 1) placed.push({ ...n, ...at(inner, angle.get(n.id)!) });
  }
  const groups = new Map<string, Neighbor[]>();
  for (const n of nodes.filter((n) => n.hop === 2)) {
    groups.set(n.via!, [...(groups.get(n.via!) ?? []), n]);
  }
  for (const [via, kids] of groups) {
    const base = angle.get(via) ?? 0;
    const spread = sector * 0.8;
    kids.forEach((n, i) => {
      const offset = kids.length === 1 ? 0 : (i / (kids.length - 1) - 0.5) * spread;
      placed.push({ ...n, ...at(outer, base + offset) });
    });
  }
  return placed;
}
