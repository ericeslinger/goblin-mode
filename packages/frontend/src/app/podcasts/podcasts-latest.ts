import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../home/icon';
import { DownloadsService } from '../reader/downloads.service';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { PlayerService } from '../reader/player.service';
import { ReaderService } from '../reader/reader.service';
import { EpisodeArt } from './episode-art';
import { type EpisodeState, episodeState, lengthText, stateText } from './episodes';
import { PodcastsBar } from './podcasts-bar';
import { PodcastsSeen } from './podcasts-seen';
import { QueueButton } from './queue-button';

/** Latest's filters (#245): New, Started, or every episode. */
export type LatestFilter = 'new' | 'started' | 'all';

/**
 * Latest (#245, step 1 of #244): the newest episodes across every show
 * followed in Podcasts, at `/podcasts`; one show's are on its page
 * since #246 (`PodcastShow`). Each
 * row has its artwork (the episode's, else its show's initials on a
 * tinted square), title, state, show, age and length, Play, and Add to
 * the queue (#249), pressed once it is in the queue; the
 * one playing has Pause and the time left. New, Started and All filter
 * them, with counts. New lasts until the episode is heard (Eric,
 * 2026-11-10): one whose notes were read says "New, notes read".
 * Opening it marks Latest seen on this device, for Right Now (#251).
 */
@Component({
  selector: 'app-podcasts-latest',
  imports: [EpisodeArt, Icon, PodcastsBar, QueueButton, RouterLink],
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
          <li>
            <app-episode-art [item]="ep" [show]="showTitle(ep)" [size]="48" />
            <a class="open" [routerLink]="['/podcasts/e', ep.id]">
              <span class="title">{{ ep.title }}</span>
              <span class="meta"
                ><span class="state" [class.fresh]="stateOf(ep) === 'new'">{{
                  stateWords(ep)
                }}</span>
                · {{ showTitle(ep) }} · {{ items.age(ep.published) }}
                @if (length(ep); as l) {
                  · {{ l }}
                }
                @if (downloads.has(ep.id)) {
                  · downloaded
                }
              </span>
            </a>
            @if (ep.enclosure) {
              <button
                type="button"
                class="play"
                [attr.aria-label]="(playing(ep) ? 'Pause ' : 'Play ') + ep.title"
                (click)="play(ep)"
              >
                <app-icon [name]="playing(ep) ? 'pause' : 'play'" [size]="22" />
              </button>
            }
            @if (ep.enclosure) {
              <app-queue-button [item]="ep" (said)="said.set($event)" />
            }
          </li>
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
    li {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: 8px 0;
      border-bottom: 1px solid var(--rule);
    }
    .open {
      flex: 1;
      min-width: 0;
      display: grid;
      gap: 2px;
      padding: 2px 4px;
      color: var(--ink);
      text-decoration: none;
    }
    .title {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .meta,
    .muted,
    .status {
      color: var(--quiet);
      font-size: 14px;
    }
    .state.fresh {
      color: var(--ink);
      font-weight: 600;
    }
    .play {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      padding: 0;
      border: var(--border) solid var(--rule);
      border-radius: 50%;
      background: var(--surface);
      cursor: pointer;
    }
  `,
})
export class PodcastsLatest {
  protected readonly items = inject(ItemsService);
  protected readonly reader = inject(ReaderService);
  protected readonly downloads = inject(DownloadsService);
  private readonly player = inject(PlayerService);

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

  protected stateOf(ep: ItemRecord): EpisodeState {
    return this.states().get(ep.id) ?? episodeState(ep);
  }

  protected stateWords(ep: ItemRecord): string {
    return stateText(ep);
  }

  protected showTitle(ep: ItemRecord): string {
    return this.reader.feeds().find((f) => f.id === ep.feedId)?.title ?? 'A show';
  }

  /** Whether this row's episode is the one playing. */
  protected playing(ep: ItemRecord): boolean {
    return this.player.current() === ep.id && this.player.playing();
  }

  /**
   * The row's length: the time left once a place is kept or it is
   * playing ("22 min left"), else how long it is; nothing when unknown.
   */
  protected length(ep: ItemRecord): string | undefined {
    return lengthText(ep, this.player, (s) => this.items.duration(s));
  }

  /** Play, or Pause the one playing, with the app's one player (#179). */
  protected play(ep: ItemRecord): void {
    if (this.player.current() === ep.id) this.player.toggle();
    else this.player.load(ep, { autoplay: true });
  }
}
