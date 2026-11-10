import {
  Component,
  type ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { HomeLink } from '../home/home-link';
import { Icon } from '../home/icon';
import { type ModuleTab, ModuleTabs } from '../home/module-tabs';
import { ModulesService } from '../modules/modules.service';
import { DownloadPrefs } from './download-prefs';
import { DownloadsService } from './downloads.service';
import { ItemsService } from './items.service';
import { ALL, SAVED } from './shelves';
import { ReaderService, type SearchHit } from './reader.service';

export type ReaderTab = 'all' | 'saved' | 'folders';

/**
 * The Reader's header and tabs (#220, #221): the leaf, then Search
 * articles, Downloads and Manage feeds as icons with names; under them
 * the tabs All (`/reader`), Saved and Folders (`/reader/folders`); the
 * Podcasts tab left with the shows for a module of their own (#245).
 * Downloads shows once anything is
 * downloaded or a podcast keeps its newest downloaded (#180), with a
 * dot while anything is. Search articles opens the search under the
 * tabs: the server's word index over every article stored (#175), the
 * shows in Podcasts left out of what it lists (#245).
 */
@Component({
  selector: 'app-reader-bar',
  imports: [HomeLink, Icon, ModuleTabs, RouterLink],
  template: `
    <header>
      <app-home-link />
      <h1>Reader</h1>
      <button
        type="button"
        class="icon"
        aria-label="Search articles"
        aria-controls="reader-search"
        [attr.aria-expanded]="searchOpen()"
        (click)="toggleSearch()"
      >
        <app-icon name="search" [size]="22" />
      </button>
      @if (showDownloads()) {
        <a class="icon" routerLink="/reader/downloads" aria-label="Downloads">
          <app-icon name="download" [size]="22" />
          @if (downloads.list().length) {
            <span class="dot" aria-hidden="true"></span>
          }
        </a>
      }
      <a class="icon" routerLink="/reader/feeds" aria-label="Manage feeds">
        <app-icon name="feeds" [size]="22" />
      </a>
    </header>
    <app-module-tabs label="Reader screens" [tabs]="tabs()" />
    @if (!modules.reader()) {
      <p class="muted">
        Reader is off. Turn it on in <a routerLink="/settings">Settings</a>, Modules.
      </p>
    }
    <div id="reader-search">
      @if (searchOpen()) {
        <form class="search" role="search" (submit)="search($event, q.value)">
          <input
            #q
            type="search"
            name="q"
            aria-label="Search articles"
            placeholder="Search articles"
            autocomplete="off"
            enterkeyhint="search"
          />
          <button type="submit" [disabled]="searching()">
            {{ searching() ? 'Searching…' : 'Search' }}
          </button>
        </form>
        @if (searchSaid()) {
          <p class="muted" aria-live="polite">{{ searchSaid() }}</p>
        }
        @if (hits(); as found) {
          @if (found.length) {
            <ul class="hits" aria-label="Articles found">
              @for (hit of found; track hit.id) {
                <li>
                  <a [routerLink]="['/reader/a', hit.id]">
                    <span class="title">{{ hit.title }}</span>
                    <span class="count">{{ sourceOf(hit) }} · {{ items.age(hit.published) }}</span>
                  </a>
                </li>
              }
            </ul>
            @if (truncated()) {
              <p class="muted">Older articles were not all searched.</p>
            }
          }
        }
      }
    </div>
    @if (reader.loaded() && reader.readerFeeds().length === 0) {
      <p class="muted">
        No feeds yet. <a routerLink="/reader/feeds">Import a file from your reader</a>, or follow
        one there.
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    header {
      display: flex;
      align-items: center;
      gap: 2px;
      margin-bottom: var(--space-2);
    }
    app-home-link {
      margin-right: var(--space-2);
    }
    h1 {
      flex: 1;
      margin: 0;
      font-size: 20px;
    }
    .icon {
      position: relative;
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
    .dot {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--second);
    }
    .search {
      display: flex;
      gap: var(--space-2);
      margin: var(--space-3) 0 var(--space-2);
    }
    .search input {
      flex: 1;
      min-width: 0;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .hits li {
      border-bottom: 1px solid var(--rule);
    }
    .hits a {
      display: grid;
      gap: 2px;
      padding: 10px 4px;
      color: var(--ink);
      text-decoration: none;
      font-weight: 600;
    }
    .hits .title {
      overflow-wrap: anywhere;
    }
    .count,
    .muted {
      color: var(--quiet);
      font-size: 14px;
      font-weight: 400;
    }
  `,
})
export class ReaderBar {
  /** The tab this screen is, or leads from. */
  readonly active = input.required<ReaderTab>();
  /** `page` on the tab's own screen; `true` on one it leads to, such as a folder's shelf. */
  readonly current = input<'page' | 'true'>('page');

  protected readonly reader = inject(ReaderService);
  protected readonly items = inject(ItemsService);
  protected readonly modules = inject(ModulesService);
  protected readonly downloads = inject(DownloadsService);
  private readonly prefs = inject(DownloadPrefs);
  private readonly injector = inject(Injector);
  private readonly box = viewChild<ElementRef<HTMLInputElement>>('q');

  /** Whether to link Downloads (#180). */
  protected readonly showDownloads = computed(
    () => this.downloads.list().length > 0 || this.prefs.keepsAny(),
  );

  protected readonly tabs = computed<ModuleTab[]>(() => {
    const counts = this.items.unreadCounts();
    const at = (tab: ReaderTab) => (this.active() === tab ? this.current() : undefined);
    const count = (shelf: string) => counts[shelf] ?? 0;
    return [
      { name: 'All', link: '/reader', count: count(ALL), counts: 'unread', current: at('all') },
      { name: 'Saved', link: ['/reader/f', SAVED], current: at('saved') },
      { name: 'Folders', link: '/reader/folders', current: at('folders') },
    ];
  });

  protected readonly searchOpen = signal(false);
  /** Search across every article (#175): what the last search found, and what it said. */
  protected readonly searching = signal(false);
  protected readonly hits = signal<SearchHit[] | undefined>(undefined);
  protected readonly searchSaid = signal('');
  /** The server stopped before the oldest articles (review on #197). */
  protected readonly truncated = signal(false);

  /** Opens the search with the cursor in its box, or closes it. */
  protected toggleSearch(): void {
    this.searchOpen.update((open) => !open);
    if (this.searchOpen()) {
      afterNextRender(() => this.box()?.nativeElement.focus(), { injector: this.injector });
    }
  }

  /**
   * Search articles (#175): the server's word index over every article
   * stored, not only the shelves at hand; one path, so it needs the
   * network.
   */
  protected async search(event: Event, text: string): Promise<void> {
    event.preventDefault();
    if (!text.trim() || this.searching()) return;
    this.searching.set(true);
    this.searchSaid.set('');
    try {
      let found = await this.reader.search(text);
      if (typeof found === 'string') {
        this.hits.set(undefined);
        this.truncated.set(false);
        this.searchSaid.set(found);
      } else {
        // The Reader's own: an episode of a show in Podcasts is not one (#245).
        found = { ...found, items: found.items.filter((h) => !this.reader.isPodcast(h.feedId)) };
        this.hits.set(found.items);
        this.truncated.set(found.truncated === true);
        if (!found.items.length) {
          this.searchSaid.set(
            found.truncated
              ? 'Nothing found in the newest articles; older ones were not searched.'
              : 'Nothing found.',
          );
        }
      }
    } finally {
      this.searching.set(false);
    }
  }

  /** The feed's name, for a row. */
  protected sourceOf(hit: SearchHit): string {
    return this.reader.feeds().find((f) => f.id === hit.feedId)?.title ?? 'Unknown feed';
  }
}
