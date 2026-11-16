import { Component, computed, effect, inject, signal } from '@angular/core';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { ReaderService } from '../reader/reader.service';
import { EpisodeRow } from './episode-row';
import { type EpisodeState, episodeState } from './episodes';
import { PodcastsBar } from './podcasts-bar';
import { PodcastsSeen } from './podcasts-seen';

/** Latest's filters (#245): New, Started, or every episode. */
export type LatestFilter = 'new' | 'started' | 'all';

/**
 * Latest (#245, step 1 of #244): the newest episodes across every show
 * followed in Podcasts, at `/podcasts`; one show's are on its page
 * since #246 (`PodcastShow`). Each row (`EpisodeRow`, #290) has its
 * artwork (the episode's, else its show's initials on a tinted square),
 * which is Play, its title, state, show, age and length, and Add to the
 * queue (#249), pressed once it is in the queue; the one playing has
 * Pause and the time left. New, Started and All filter them, with
 * counts. New lasts until the episode is heard (Eric,
 * 2026-11-10): one whose notes were read says "New, notes read".
 * Opening it marks Latest seen on this device, for Right Now (#251).
 */
@Component({
  selector: 'app-podcasts-latest',
  imports: [EpisodeRow, PodcastsBar],
  template: `
    <main class="page">
      <app-podcasts-bar active="latest" />
      <h2 class="visually-hidden">Latest</h2>
      <div class="filters" role="group" aria-label="Which episodes">
        @for (f of filters(); track f.id) {
          <button
            type="button"
            [attr.aria-pressed]="filter() === f.id ? 'true' : 'false'"
            (click)="filter.set(f.id)"
          >
            {{ f.name }}
            @if (f.count !== undefined) {
              <span class="count">{{ f.count }}</span>
            }
          </button>
        }
      </div>
      @if (items.loaded() && list().length === 0 && reader.podcastFeeds().length) {
        <p class="muted">{{ emptyText() }}</p>
      }
      <ul aria-label="Episodes">
        @for (ep of list(); track ep.id) {
          <li appEpisodeRow [item]="ep" [show]="showTitle(ep)" (said)="said.set($event)"></li>
        }
      </ul>
      @if (said()) {
        <p class="status" role="status">{{ said() }}</p>
      }
    </main>
  `,
  styles: `
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin: var(--space-3) 0 var(--space-2);
    }
    .filters button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 44px;
      padding: 0 14px;
      font: inherit;
      font-size: 14px;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      cursor: pointer;
    }
    .filters button[aria-pressed='true'] {
      font-weight: 600;
      background: var(--chip-bg);
      border-color: var(--ink);
    }
    .count {
      font-family: var(--font-mono);
      font-size: 12px;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      border-top: 1px solid var(--rule);
    }
    .muted,
    .status {
      color: var(--quiet);
      font-size: 14px;
    }
  `,
})
export class PodcastsLatest {
  protected readonly items = inject(ItemsService);
  protected readonly reader = inject(ReaderService);

  constructor() {
    // Seen while open (#251): Right Now's "new in Podcasts" counts only
    // what comes out after, episodes arriving here included.
    const seen = inject(PodcastsSeen);
    effect(() => {
      this.items.episodes();
      seen.markSeen();
    });
  }
  protected readonly filter = signal<LatestFilter>('new');
  /** What a row's queue button could not do (review on #252: the queue is full). */
  protected readonly said = signal('');

  /** The episodes before the filter: every show's. */
  private readonly all = computed(() => this.items.episodes());
  private readonly states = computed(() => {
    const out = new Map<string, EpisodeState>();
    for (const e of this.all()) out.set(e.id, episodeState(e));
    return out;
  });
  protected readonly filters = computed(() => {
    const states = [...this.states().values()];
    const n = (s: EpisodeState) => states.filter((x) => x === s).length;
    return [
      { id: 'new' as const, name: 'New', count: n('new') },
      { id: 'started' as const, name: 'Started', count: n('started') },
      { id: 'all' as const, name: 'All', count: undefined },
    ];
  });
  protected readonly list = computed(() => {
    const f = this.filter();
    const states = this.states();
    return f === 'all' ? this.all() : this.all().filter((e) => states.get(e.id) === f);
  });
  protected readonly emptyText = computed(() => {
    switch (this.filter()) {
      case 'new':
        return 'Nothing new: every episode is started or heard.';
      case 'started':
        return 'Nothing started.';
      default:
        return 'No episodes yet. They arrive once the server has looked.';
    }
  });

  protected showTitle(ep: ItemRecord): string {
    return this.reader.feeds().find((f) => f.id === ep.feedId)?.title ?? 'A show';
  }
}
