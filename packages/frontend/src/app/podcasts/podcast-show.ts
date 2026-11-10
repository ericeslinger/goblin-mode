import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { HomeLink } from '../home/home-link';
import { Icon } from '../home/icon';
import { DownloadPrefs, KEEP_CHOICES, keepText } from '../reader/download-prefs';
import { DownloadsService } from '../reader/downloads.service';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { PlayerService } from '../reader/player.service';
import { renamedFolder } from '../reader/reader-feeds';
import { type FeedRecord, ReaderService, cleanFolder } from '../reader/reader.service';
import { type EpisodeState, episodeState, lengthText, stateText } from './episodes';
import { QueueButton } from './queue-button';
import { ShowArt } from './show-art';

/** A show's filters (#246): the episodes not heard yet, or every one at hand. */
export type ShowFilter = 'unheard' | 'all';

/** What the More sheet shows: its buttons, the folder to move to, or the confirm. */
type Step = 'menu' | 'folder' | 'unfollow';

/**
 * One show's page (#246, step 2 of #244; Eric 2026-11-10: a "good
 * interface to find back episodes in a given podcast"), at
 * `/podcasts/s/<feedId>` under Shows: its artwork, its name, how many
 * episodes are at hand and unheard, its folders; New episodes join the
 * queue (`autoQueue`: the fetcher appends its new episodes to the
 * listening queue, #249) and how many to keep
 * downloaded; then its episodes, Unheard or All, newest or oldest
 * first, searched by title and notes among those loaded. Show older
 * episodes reads the next hundred past the newest hundred the app
 * listens to, kept while the app is open. More is a sheet (a modal
 * dialog: focus stays inside, Escape closes) with Move to a folder,
 * Move to the Reader, Mark all as heard and Unfollow, which asks first.
 */
@Component({
  selector: 'app-podcast-show',
  imports: [HomeLink, Icon, QueueButton, RouterLink, ShowArt],
  template: `
    <main class="page">
      <header class="top">
        <app-home-link />
        <a class="back" routerLink="/podcasts/shows"
          ><app-icon name="chevron-left" [size]="18" />Shows</a
        >
        <span class="spacer"></span>
        @if (show(); as s) {
          <button
            type="button"
            class="icon"
            aria-label="Search this show"
            aria-controls="show-search"
            [attr.aria-expanded]="searching()"
            (click)="toggleSearch()"
          >
            <app-icon name="search" [size]="22" />
          </button>
          <button
            type="button"
            class="icon"
            aria-haspopup="dialog"
            [attr.aria-label]="'More for ' + s.title"
            (click)="openMore()"
          >
            <app-icon name="more" [size]="22" />
          </button>
        }
      </header>
      @if (show(); as s) {
        <div class="head">
          <app-show-art [id]="s.id" [title]="s.title" [src]="art()" [size]="96" />
          <div>
            <h1>{{ s.title }}</h1>
            <p class="meta">{{ countLine() }}</p>
            <p class="meta">{{ foldersLine() }}</p>
          </div>
        </div>
        @if (s.dead || s.error) {
          <p class="muted">
            {{ s.dead ? 'Not answering for a month, given up.' : 'Last look failed: ' + s.error }}
            <button type="button" (click)="reader.retry(s.id)">Try again</button>
          </p>
        }
        <div class="settings">
          <label class="switch">
            <input
              type="checkbox"
              role="switch"
              [checked]="s.autoQueue === true"
              (change)="reader.setAutoQueue(s.id, $any($event.target).checked)"
            />
            <span class="text">
              <span>New episodes join the queue</span>
              <span class="meta">{{
                s.autoQueue
                  ? 'On: its new episodes go to the end of the queue'
                  : 'Off: you add episodes yourself'
              }}</span>
            </span>
          </label>
          <label class="keep">
            Keep downloaded
            <select
              [attr.aria-label]="'Episodes of ' + s.title + ' kept downloaded'"
              (change)="prefs.setKeep(s.id, +$any($event.target).value)"
            >
              @for (n of keepChoices; track n) {
                <option [value]="n" [selected]="prefs.keepFor(s.id) === n">
                  {{ keepText(n) }}
                </option>
              }
            </select>
          </label>
        </div>
        @if (searching()) {
          <div class="search" id="show-search">
            <input
              #search
              type="search"
              enterkeyhint="search"
              [attr.aria-label]="'Search ' + s.title"
              placeholder="Titles and notes"
              [value]="query()"
              (input)="query.set(search.value)"
            />
            <p class="muted">
              Searches the {{ all().length }} {{ all().length === 1 ? 'episode' : 'episodes' }}
              loaded here, by title and notes.
            </p>
          </div>
        }
        <div class="bar">
          <div class="filters" role="group" aria-label="Which episodes">
            @for (f of filters(); track f.id) {
              <button
                type="button"
                [attr.aria-pressed]="filter() === f.id ? 'true' : 'false'"
                (click)="filter.set(f.id)"
              >
                {{ f.name }} <span class="count">{{ f.count }}</span>
              </button>
            }
          </div>
          <button type="button" class="sort" (click)="oldestFirst.set(!oldestFirst())">
            <app-icon name="sort" [size]="16" />{{
              oldestFirst() ? 'Oldest first' : 'Newest first'
            }}
          </button>
        </div>
        @if (items.loaded() && list().length === 0) {
          <p class="muted">{{ emptyText() }}</p>
        }
        <ul aria-label="Episodes">
          @for (ep of list(); track ep.id) {
            <li>
              <a class="open" [routerLink]="['/podcasts/e', ep.id]" [queryParams]="{ show: s.id }">
                <span class="title">{{ ep.title }}</span>
                <span class="meta"
                  ><span class="state" [class.fresh]="stateOf(ep) === 'new'">{{
                    stateWords(ep)
                  }}</span>
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
              @if (ep.enclosure) {
                <app-queue-button [item]="ep" (said)="said.set($event)" />
              }
            </li>
          }
        </ul>
        @if (items.mayHaveOlder(s.id)) {
          <p class="older">
            <button type="button" [disabled]="loadingOlder()" (click)="older(s.id)">
              {{ loadingOlder() ? 'Loading older episodes…' : 'Show older episodes' }}
            </button>
          </p>
        }
        @if (said()) {
          <p class="status" role="status">{{ said() }}</p>
        }
        <dialog
          #more
          class="sheet"
          [attr.aria-label]="'More for ' + s.title"
          (close)="step.set('menu')"
          (click)="backdrop($event)"
        >
          <p class="sheet-name">{{ s.title }}</p>
          @switch (step()) {
            @case ('folder') {
              <form class="folder" novalidate (submit)="move($event, s, folderInput.value)">
                <label class="field">
                  Folder
                  <input
                    #folderInput
                    list="show-folders"
                    placeholder="Not in a folder"
                    enterkeyhint="done"
                    [value]="s.folders[0] ?? ''"
                  />
                </label>
                <datalist id="show-folders">
                  @for (name of reader.podcastFolderNames(); track name) {
                    <option [value]="name"></option>
                  }
                </datalist>
                <p class="muted">Empty takes it out of its folders.</p>
                <button type="submit">Move</button>
                <button type="button" (click)="go('menu')">Back</button>
              </form>
            }
            @case ('unfollow') {
              <p>
                Unfollow {{ s.title }}? Its episodes go with it, but for any saved or filed in the
                garden.
              </p>
              <button type="button" class="danger" (click)="unfollow(s)">
                Unfollow {{ s.title }}
              </button>
              <button type="button" (click)="go('menu')">Keep following</button>
            }
            @default {
              <button type="button" (click)="go('folder')">Move to a folder</button>
              <button type="button" (click)="toReader(s)">
                Move to the Reader
                <span class="hint">For a feed that is mostly writing</span>
              </button>
              <button type="button" (click)="markAll(s)">Mark all as heard</button>
              <button type="button" (click)="go('unfollow')">Unfollow</button>
              <button type="button" (click)="closeMore()">Close</button>
            }
          }
        </dialog>
      } @else if (said()) {
        <p class="status" role="status">{{ said() }}</p>
      } @else if (reader.loaded()) {
        <p class="muted">That show is not followed here.</p>
      }
    </main>
  `,
  styles: `
    .top {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .back {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 44px;
      margin-left: var(--space-2);
      padding: 0 8px;
      color: var(--quiet);
      text-decoration: none;
    }
    .spacer {
      flex: 1;
    }
    .icon {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-control);
      background: transparent;
      cursor: pointer;
    }
    .icon[aria-expanded='true'] {
      background: var(--chip-bg);
    }
    .head {
      display: flex;
      gap: var(--space-3);
      align-items: flex-start;
      margin-top: var(--space-2);
    }
    h1 {
      margin: 0 0 4px;
      font-size: 22px;
      overflow-wrap: anywhere;
    }
    .head .meta {
      margin: 2px 0;
    }
    .meta,
    .muted,
    .status,
    .hint {
      color: var(--quiet);
      font-size: 14px;
      font-weight: 400;
    }
    .settings {
      display: grid;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    .settings .muted {
      margin: 0;
    }
    .switch {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: 10px 12px;
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-card);
    }
    .text {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .keep {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      color: var(--quiet);
      font-size: 14px;
    }
    .search {
      margin-top: var(--space-3);
    }
    .search input {
      box-sizing: border-box;
      width: 100%;
      min-height: 44px;
      font: inherit;
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin: var(--space-3) 0 var(--space-2);
    }
    .filters {
      flex: 1;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .filters button,
    .sort {
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
    .older button {
      min-height: 44px;
    }
    .sheet {
      box-sizing: border-box;
      width: min(100% - 32px, 420px);
      margin: auto auto 16px;
      padding: var(--space-3);
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-card);
    }
    .sheet::backdrop {
      background: color-mix(in srgb, var(--ink) 35%, transparent);
    }
    .sheet[open],
    .sheet .folder {
      display: grid;
      gap: var(--space-2);
    }
    .sheet-name {
      margin: 0;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .sheet p {
      margin: 0;
    }
    .sheet button {
      display: grid;
      justify-items: start;
      gap: 2px;
      min-height: 44px;
      padding: 6px 12px;
      font: inherit;
      text-align: left;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      cursor: pointer;
    }
    .sheet .danger {
      font-weight: 600;
      border-color: var(--ink);
    }
    .field {
      display: grid;
      gap: 4px;
    }
    .field input {
      min-height: 44px;
      font: inherit;
    }
  `,
})
export class PodcastShow {
  protected readonly items = inject(ItemsService);
  protected readonly reader = inject(ReaderService);
  protected readonly downloads = inject(DownloadsService);
  protected readonly prefs = inject(DownloadPrefs);
  private readonly player = inject(PlayerService);
  private readonly injector = inject(Injector);
  protected readonly keepChoices = KEEP_CHOICES;
  private readonly moreDialog = viewChild<ElementRef<HTMLDialogElement>>('more');
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly showId = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((p) => p.get('feedId') ?? '')),
    { initialValue: '' },
  );
  /** The show, while it is one followed in Podcasts. */
  protected readonly show = computed(() =>
    this.reader.podcastFeeds().find((f) => f.id === this.showId()),
  );
  protected readonly filter = signal<ShowFilter>('unheard');
  protected readonly oldestFirst = signal(false);
  protected readonly searching = signal(false);
  protected readonly query = signal('');
  protected readonly said = signal('');
  protected readonly loadingOlder = signal(false);
  protected readonly step = signal<Step>('menu');

  /**
   * Every episode of the show at hand, newest first: the newest hundred
   * the app listens to, then any older pages loaded here.
   */
  protected readonly all = computed(() => {
    const id = this.showId();
    const listened = this.items.episodes().filter((e) => e.feedId === id);
    const seen = new Set(listened.map((e) => e.id));
    const older = this.items.olderEpisodes(id).filter((e) => !seen.has(e.id));
    return [...listened, ...older].sort((a, b) => b.published - a.published);
  });
  private readonly unheard = computed(() => this.all().filter((e) => !e.played));
  /** The feed's own image, else its newest episode's (#246). */
  protected readonly art = computed(
    () => this.show()?.image ?? this.all().find((e) => e.image)?.image,
  );
  protected readonly countLine = computed(() => {
    const n = this.all().length;
    const more = this.items.mayHaveOlder(this.showId()) ? '+' : '';
    return `${n}${more} ${n === 1 && !more ? 'episode' : 'episodes'} · ${this.unheard().length} unheard`;
  });
  protected readonly foldersLine = computed(() => {
    const folders = this.show()?.folders ?? [];
    return folders.length ? `In ${folders.join(', ')}` : 'Not in a folder';
  });
  protected readonly filters = computed(() => [
    { id: 'unheard' as const, name: 'Unheard', count: this.unheard().length },
    { id: 'all' as const, name: 'All', count: this.all().length },
  ]);
  protected readonly list = computed(() => {
    const words = this.searching() ? this.query().toLowerCase().split(/\s+/).filter(Boolean) : [];
    const pool = this.filter() === 'unheard' ? this.unheard() : this.all();
    const found = words.length
      ? pool.filter((e) => {
          const text = `${e.title}\n${e.summary}\n${e.content}`.toLowerCase();
          return words.every((w) => text.includes(w));
        })
      : pool;
    return this.oldestFirst() ? [...found].reverse() : found;
  });
  protected readonly emptyText = computed(() => {
    if (this.searching() && this.query().trim()) return 'No episode loaded here holds those words.';
    if (this.filter() === 'unheard' && this.all().length) return 'Every episode here is heard.';
    return 'No episodes yet. They arrive once the server has looked.';
  });

  protected stateOf(ep: ItemRecord): EpisodeState {
    return episodeState(ep);
  }

  protected stateWords(ep: ItemRecord): string {
    return stateText(ep);
  }

  protected playing(ep: ItemRecord): boolean {
    return this.player.current() === ep.id && this.player.playing();
  }

  protected length(ep: ItemRecord): string | undefined {
    return lengthText(ep, this.player, (s) => this.items.duration(s));
  }

  /** Play, or Pause the one playing, with the app's one player (#179). */
  protected play(ep: ItemRecord): void {
    if (this.player.current() === ep.id) this.player.toggle();
    else this.player.load(ep, { autoplay: true });
  }

  protected keepText(n: number): string {
    return keepText(n);
  }

  /** Search this show: opens the field, focused; closing it shows every episode again. */
  protected toggleSearch(): void {
    const open = !this.searching();
    this.searching.set(open);
    if (open) {
      afterNextRender(() => this.searchInput()?.nativeElement.focus(), {
        injector: this.injector,
      });
    }
  }

  /** Show older episodes (#246): the next hundred, read once; said when none could be. */
  protected async older(id: string): Promise<void> {
    this.loadingOlder.set(true);
    this.said.set('');
    try {
      const got = await this.items.loadOlder(id);
      if (typeof got === 'string') this.said.set(got);
      else if (got === 0) this.said.set('No older episodes.');
    } finally {
      this.loadingOlder.set(false);
    }
  }

  protected openMore(): void {
    this.step.set('menu');
    this.moreDialog()?.nativeElement.showModal();
  }

  protected closeMore(): void {
    this.moreDialog()?.nativeElement.close();
  }

  /** A click on the sheet's backdrop closes it, as Escape does. */
  protected backdrop(event: MouseEvent): void {
    if (event.target === this.moreDialog()?.nativeElement) this.closeMore();
  }

  /** Another step of the sheet, its first control focused so focus stays inside. */
  protected go(step: Step): void {
    this.step.set(step);
    afterNextRender(
      () => this.moreDialog()?.nativeElement.querySelector<HTMLElement>('input, button')?.focus(),
      { injector: this.injector },
    );
  }

  /**
   * Move to a folder: the show in that one folder (the Reader's naming,
   * #185), or in none when empty, through the cache.
   */
  protected move(event: Event, feed: FeedRecord, typed: string): void {
    event.preventDefault();
    const folder = cleanFolder(typed);
    this.reader.setFolders(feed.id, folder ? [folder] : []);
    this.said.set(
      renamedFolder([typed]) ||
        (folder ? `${feed.title} is in ${folder} now.` : `${feed.title} is in no folder now.`),
    );
    this.closeMore();
  }

  /**
   * Move to the Reader (#245): the feed's kind cleared; its articles are
   * the Reader's now. Its queued episodes leave the queue in the same
   * batch (#251), and the status says how many.
   */
  protected toReader(feed: FeedRecord): void {
    this.closeMore();
    const left = this.items.moveToReader(feed.id);
    const queue = left ? ` ${left} ${left === 1 ? 'episode' : 'episodes'} left the queue.` : '';
    this.said.set(`${feed.title} is in the Reader now.${queue}`);
  }

  /**
   * Mark all as heard (#246): `played` on every unheard episode loaded
   * here, in one batch through the cache. Older ones not loaded are
   * left as they are; Show older episodes and Mark all again reach them.
   */
  protected markAll(feed: FeedRecord): void {
    const ids = this.unheard().map((e) => e.id);
    const n = this.items.setPlayedMany(ids);
    const rest = this.items.mayHaveOlder(feed.id)
      ? ' Older episodes not loaded here are left as they were.'
      : '';
    this.said.set(
      n ? `Marked ${n} ${n === 1 ? 'episode' : 'episodes'} heard.${rest}` : 'Nothing unheard here.',
    );
    this.closeMore();
  }

  protected unfollow(feed: FeedRecord): void {
    this.closeMore();
    this.reader.removeFeed(feed.id);
    this.said.set(`Unfollowed ${feed.title}.`);
  }
}
