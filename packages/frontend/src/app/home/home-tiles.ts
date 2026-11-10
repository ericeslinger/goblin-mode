import { Injectable, inject, signal } from '@angular/core';
import { LocalStore } from '../platform/local-store';

/**
 * Home's tiles as the gardener arranged them (#222), kept on this
 * device so they apply before auth and the network, as Start on is;
 * the `settings/app` doc is the source of truth once signed in
 * (ThemeSync carries it as `homeTiles` and `homeHidden`).
 */
export const HOME_TILES_KEY = 'goblin.homeTiles';

/** Every tile, in the fixed default order a missing one joins in. */
export const TILE_IDS = [
  'notes',
  'kitchen',
  'reader',
  'podcasts',
  'reading',
  'assistants',
  'map',
] as const;

export interface Arrangement {
  /** Tile ids in the order chosen; a tile not in it joins at the end. */
  order: string[];
  /** Tile ids taken off Home, listed under Not on Home. */
  hidden: string[];
}

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * The tiles Home shows, in order, and those Not on Home, for an
 * arrangement and the tiles that can show (a module that is off has
 * none, whatever the order says), given in the default order.
 */
export function arrange(
  { order, hidden }: Arrangement,
  available: readonly string[],
): { shown: string[]; off: string[] } {
  const can = new Set(available);
  const out = new Set(hidden);
  const shown = [...new Set(order)].filter((id) => can.has(id) && !out.has(id));
  for (const id of available) if (!out.has(id) && !shown.includes(id)) shown.push(id);
  return { shown, off: available.filter((id) => out.has(id)) };
}

/** The list with `id` moved `by` places, or undefined past either end. */
export function moveBy(list: readonly string[], id: string, by: number): string[] | undefined {
  const from = list.indexOf(id);
  const to = from + by;
  if (from < 0 || by === 0 || to < 0 || to >= list.length) return undefined;
  return moveTo(list, id, to);
}

/** The list with `id` at index `to`. */
export function moveTo(list: readonly string[], id: string, to: number): string[] {
  const rest = list.filter((x) => x !== id);
  rest.splice(to, 0, id);
  return rest;
}

@Injectable({ providedIn: 'root' })
export class HomeTilesService {
  private readonly store = inject(LocalStore);
  private stored = this.store.get<Partial<Arrangement>>(HOME_TILES_KEY);

  readonly arrangement = signal<Arrangement>({
    order: ids(this.stored?.order),
    hidden: ids(this.stored?.hidden),
  });
  /** Counts arrangements made here, for ThemeSync to write; adopted ones do not count. */
  readonly chosen = signal(0);

  /** Whether this device has an arrangement of its own, to upload to a new doc. */
  hasStoredChoice(): boolean {
    return this.stored !== undefined;
  }

  /**
   * Home's tiles in a new order. Ids not shown (a module that is off)
   * keep their place after them, so they are not forgotten.
   */
  reorder(shown: readonly string[]): void {
    const { order, hidden } = this.arrangement();
    this.set({ order: [...shown, ...order.filter((id) => !shown.includes(id))], hidden });
  }

  /** A tile put back on Home, at the end of `shown`. */
  add(id: string, shown: readonly string[]): void {
    const { order, hidden } = this.arrangement();
    this.set({
      order: [...shown, id, ...order.filter((x) => x !== id && !shown.includes(x))],
      hidden: hidden.filter((x) => x !== id),
    });
  }

  /** A tile taken off Home, to Not on Home. */
  remove(id: string): void {
    const { order, hidden } = this.arrangement();
    if (!hidden.includes(id)) this.set({ order, hidden: [...hidden, id] });
  }

  /** An arrangement made here: kept, and written to the doc by ThemeSync. */
  set(arrangement: Arrangement): void {
    this.adopt(arrangement);
    this.chosen.update((n) => n + 1);
  }

  /** An arrangement from the doc, made on this or another device. */
  adopt(arrangement: Arrangement): void {
    this.arrangement.set(arrangement);
    this.stored = arrangement;
    this.store.set(HOME_TILES_KEY, arrangement);
  }
}

/** A tile's place in the list, relative to it. */
export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The slot whose centre is nearest a point. */
export function nearestSlot(slots: readonly Slot[], x: number, y: number): number {
  let best = 0;
  let bestDistance = Infinity;
  slots.forEach((s, i) => {
    const distance = Math.hypot(s.x + s.w / 2 - x, s.y + s.h / 2 - y);
    if (distance < bestDistance) [best, bestDistance] = [i, distance];
  });
  return best;
}
