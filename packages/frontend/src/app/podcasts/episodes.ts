import type { ItemRecord } from '../reader/items.service';

/**
 * An episode's state (#245, Eric 2026-11-10): New until it is heard.
 * Only listening changes it: Started once a place past the start is
 * kept, Heard once played to the end or marked so. Reading its notes
 * (`read`) changes none of them.
 */
export type EpisodeState = 'new' | 'started' | 'heard';

export function episodeState(ep: Pick<ItemRecord, 'played' | 'position'>): EpisodeState {
  if (ep.played) return 'heard';
  return (ep.position ?? 0) > 0 ? 'started' : 'new';
}

const WORDS: Record<EpisodeState, string> = { new: 'New', started: 'Started', heard: 'Heard' };

/** The state in words for a row: "New", or "New, notes read" once its notes were read. */
export function stateText(ep: Pick<ItemRecord, 'played' | 'position' | 'read'>): string {
  const state = episodeState(ep);
  return state !== 'heard' && ep.read ? `${WORDS[state]}, notes read` : WORDS[state];
}

/** A show's initials for the square that stands in for its artwork: "Kiln talk" is KT. */
export function initials(title: string): string {
  const words = title
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.slice(0, 2).map((w) => [...w][0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

/**
 * How strongly a show's square is tinted, from its id, so each show
 * keeps its own: a share of the theme's second colour, 14 to 32 per
 * cent, light enough that the ink initials keep their contrast.
 */
export function tint(feedId: string): number {
  let h = 0;
  for (const c of feedId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 14 + (h % 5) * 4.5;
}
