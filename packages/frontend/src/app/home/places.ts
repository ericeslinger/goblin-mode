import { Injectable, computed, inject } from '@angular/core';
import { ProposalsService } from '../claude/proposals.service';
import { ModulesService } from '../modules/modules.service';
import { episodeState } from '../podcasts/episodes';
import { ItemsService } from '../reader/items.service';
import { ReadingService } from '../reading/reading.service';
import { RemindersService } from '../reminders/reminders.service';
import { TILE_IDS } from './home-tiles';
import type { IconName } from './icon';

/**
 * The places Mossgoblin has (#219, #289): what Home's tiles and the
 * desktop rail name, draw and count, from one source so the two cannot
 * disagree. A place's name, icon and link are fixed; whether it shows
 * (a module that is off has neither a tile nor an entry) and its count
 * come from `PlacesService`.
 */
export type PlaceId =
  | 'home'
  | 'notes'
  | 'right-now'
  | 'kitchen'
  | 'reader'
  | 'podcasts'
  | 'reading'
  | 'map'
  | 'assistants'
  | 'settings';

export interface Place {
  name: string;
  icon: IconName;
  link: string;
}

export const PLACES: Record<PlaceId, Place> = {
  home: { name: 'Home', icon: 'leaf', link: '/home' },
  notes: { name: 'Notes', icon: 'notes', link: '/browse' },
  'right-now': { name: 'Right Now', icon: 'right-now', link: '/right-now' },
  kitchen: { name: 'Kitchen', icon: 'kitchen', link: '/kitchen' },
  reader: { name: 'Reader', icon: 'reader', link: '/reader' },
  podcasts: { name: 'Podcasts', icon: 'podcasts', link: '/podcasts' },
  reading: { name: 'Reading queue', icon: 'reading', link: '/reading' },
  map: { name: 'Map', icon: 'map', link: '/map' },
  assistants: { name: 'Assistants', icon: 'assistants', link: '/activity' },
  settings: { name: 'Settings', icon: 'settings', link: '/settings' },
};

/** The rail's entries, in order (#289, Eric 2026-11-15); Settings is pinned at its foot. */
export const RAIL_PLACES: readonly PlaceId[] = [
  'home',
  'notes',
  'right-now',
  'kitchen',
  'reader',
  'podcasts',
  'reading',
  'map',
  'assistants',
];

/** The module a place belongs to, where it is one; the rest are always there. */
const PLACE_MODULE: Partial<Record<PlaceId, 'kitchen' | 'reader' | 'podcasts'>> = {
  kitchen: 'kitchen',
  reader: 'reader',
  podcasts: 'podcasts',
};

/**
 * Whether a place shows, from the modules alone: a module that is off
 * has no tile, no entry and no key (#289). A pure function, so the
 * keys can ask without starting the counts' listeners.
 */
export function placeOn(
  id: PlaceId,
  modules: Record<'kitchen' | 'reader' | 'podcasts', () => boolean>,
): boolean {
  const module = PLACE_MODULE[id];
  return !module || modules[module]();
}

/** A place's count, and what it counts, for the screen reader ("unread"). */
export interface PlaceCount {
  n: number;
  counts: string;
}

/** "Reader, 179 unread": a place's name with its count, as a link's name. */
export function placeLabel(name: string, count?: PlaceCount): string {
  return count && count.n > 0 ? `${name}, ${count.n} ${count.counts}` : name;
}

@Injectable({ providedIn: 'root' })
export class PlacesService {
  private readonly modules = inject(ModulesService);
  private readonly reminders = inject(RemindersService);
  private readonly items = inject(ItemsService);
  private readonly reading = inject(ReadingService);
  private readonly proposals = inject(ProposalsService);

  /** Whether a place shows: a module that is off has no tile and no entry. */
  readonly isOn = computed(() => {
    const on = new Set(
      (Object.keys(PLACES) as PlaceId[]).filter((id) => placeOn(id, this.modules)),
    );
    return (id: PlaceId) => on.has(id);
  });

  /** Home's tiles that can show, in the default order (`TILE_IDS`). */
  readonly tiles = computed(() => TILE_IDS.filter((id) => this.isOn()(id)));

  /** The Reader's unread articles, every folder. */
  readonly readerUnread = computed(() => this.items.unreadCounts()['all'] ?? 0);
  /** Episodes not yet started (#251). */
  readonly podcastsNew = computed(
    () => this.items.episodes().filter((e) => episodeState(e) === 'new').length,
  );
  /** What is in the listening queue (#249). */
  readonly podcastsQueued = computed(() => this.items.queue().length);
  /** Saved to read and not read yet. */
  readonly toRead = computed(() => this.reading.unread().length);
  /** The assistants' open suggestions. */
  readonly suggestions = computed(() => this.proposals.open());
  /** Reminders overdue or due today, as Right Now lists them. */
  readonly due = computed(() => this.reminders.due().length);

  /**
   * Each counted place's count: the numbers Home's tiles show (Right
   * Now's is its row's reminders), for the rail beside them.
   */
  readonly counts = computed<Partial<Record<PlaceId, PlaceCount>>>(() => {
    const suggestions = this.suggestions();
    return {
      'right-now': { n: this.due(), counts: 'due' },
      reader: { n: this.readerUnread(), counts: 'unread' },
      podcasts: { n: this.podcastsNew(), counts: 'new' },
      reading: { n: this.toRead(), counts: 'to read' },
      assistants: {
        n: suggestions,
        counts: suggestions === 1 ? 'suggestion' : 'suggestions',
      },
    };
  });
}
