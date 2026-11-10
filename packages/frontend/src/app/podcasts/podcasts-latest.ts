import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { Icon } from '../home/icon';
import { DownloadPrefs, KEEP_CHOICES } from '../reader/download-prefs';
import { DownloadsService } from '../reader/downloads.service';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { PlayerService } from '../reader/player.service';
import { ReaderService } from '../reader/reader.service';
import { EpisodeArt } from './episode-art';
import { type EpisodeState, episodeState, stateText } from './episodes';
import { PodcastsBar } from './podcasts-bar';

/** Latest's filters (#245): New, Started, or every episode. */
export type LatestFilter = 'new' | 'started' | 'all';

/**
 * Latest (#245, step 1 of #244): the newest episodes across every show
 * followed in Podcasts, at `/podcasts`, or one show's at
 * `/podcasts/s/<feedId>` (under Shows, which step 2 makes a grid). Each
 * row has its artwork (the episode's, else its show's initials on a
 * tinted square), title, state, show, age and length, and Play; the
 * one playing has Pause and the time left. New, Started and All filter
 * them, with counts. New lasts until the episode is heard (Eric,
 * 2026-11-10): one whose notes were read says "New, notes read".
 */
@Component({
  selector: 'app-podcasts-latest',
  imports: [EpisodeArt, Icon, PodcastsBar, RouterLink],
  template: `
    <main class="page">
      <app-podcasts-bar
        [active]="showId() ? 'shows' : 'latest'"
        [current]="showId() ? 'true' : 'page'"
      />
      @if (show(); as s) {
        <a class="up" routerLink="/podcasts/shows"
          ><app-icon name="chevron-left" [size]="18" />Shows</a
        >
        <h2>{{ s.title }}</h2>
        @if (s.dead || s.error) {
          <p class="muted">
            {{ s.dead ? 'Not answering for a month, given up.' : 'Last look failed: ' + s.error }}
            <button type="button" (click)="reader.retry(s.id)">Try again</button>
          </p>
        }
        <label class="keep">
          Keep downloaded
          <select
            [attr.aria-label]="'Episodes of ' + s.title + ' kept downloaded'"
            (change)="prefs.setKeep(s.id, +$any($event.target).value)"
          >
            @for (n of keepChoices; track n) {
              <option [value]="n" [selected]="prefs.keepFor(s.id) === n">{{ keepText(n) }}</option>
            }
          </select>
        </label>
      } @else if (showId()) {
        <a class="up" routerLink="/podcasts/shows"
          ><app-icon name="chevron-left" [size]="18" />Shows</a
        >
        <p class="muted">That show is not followed here.</p>
      } @else {
        <h2 class="visually-hidden">Latest</h2>
      }
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
            <a
              class="open"
              [routerLink]="['/podcasts/e', ep.id]"
              [queryParams]="showId() ? { show: showId() } : null"
            >
              <span class="title">{{ ep.title }}</span>
              <span class="meta"
                ><span class="state" [class.fresh]="stateOf(ep) === 'new'">{{
                  stateWords(ep)
                }}</span>
                @if (!showId()) {
                  · {{ showTitle(ep) }}
                }
                · {{ items.age(ep.published) }}
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
          </li>
        }
      </ul>
    </main>
  `,
  styles: `
    .up {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 44px;
      margin-top: var(--space-2);
      color: var(--quiet);
      text-decoration: none;
    }
    h2 {
      margin: 0;
      font-size: 18px;
    }
    .keep {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      margin: var(--space-2) 0 0;
      color: var(--quiet);
      font-size: 14px;
    }
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
    .muted {
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
  protected readonly prefs = inject(DownloadPrefs);
  private readonly player = inject(PlayerService);
  protected readonly keepChoices = KEEP_CHOICES;
  protected readonly showId = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((p) => p.get('feedId') ?? undefined)),
    { initialValue: undefined },
  );
  /** The show whose episodes these are, when the list is one show's. */
  protected readonly show = computed(() => {
    const id = this.showId();
    return id ? this.reader.podcastFeeds().find((f) => f.id === id) : undefined;
  });
  protected readonly filter = signal<LatestFilter>('new');

  /** The episodes before the filter: every show's, or the one show's. */
  private readonly all = computed(() => {
    const id = this.showId();
    const episodes = this.items.episodes();
    return id ? episodes.filter((e) => e.feedId === id) : episodes;
  });
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
    const current = this.player.current() === ep.id;
    const total = current ? this.player.duration() : ep.enclosure?.seconds;
    if (!total) return undefined;
    const at = current ? this.player.position() : ep.played ? 0 : (ep.position ?? 0);
    return at > 0
      ? `${this.items.duration(Math.max(0, total - at))} left`
      : this.items.duration(total);
  }

  /** Play, or Pause the one playing, with the app's one player (#179). */
  protected play(ep: ItemRecord): void {
    if (this.player.current() === ep.id) this.player.toggle();
    else this.player.load(ep, { autoplay: true });
  }

  /** A choice of how many newest episodes to keep downloaded (#180). */
  protected keepText(n: number): string {
    return n === 0 ? 'by hand only' : n === 1 ? 'the newest' : `the newest ${n}`;
  }
}
