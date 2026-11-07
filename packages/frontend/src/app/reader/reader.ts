import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ModulesService } from '../modules/modules.service';
import { DownloadPrefs } from './download-prefs';
import { DownloadsService, size } from './downloads.service';
import { ALL, type ItemRecord, ItemsService, PODCASTS, SAVED } from './items.service';
import { ReaderService, type SearchHit } from './reader.service';

/**
 * The Reader's front (#162): the folders with what is unread in each,
 * All and Saved, Podcasts once a feed is one (#178), Refresh, and the
 * way to Manage feeds; above the folders, Continue listening, the
 * episodes left part-way on any device, newest first (#179). Downloads
 * is linked once anything is downloaded or a podcast keeps its newest
 * downloaded (#180). Search articles looks through every article
 * stored, by the server's word index (#175).
 */
@Component({
  selector: 'app-reader',
  imports: [RouterLink],
  template: `
    <main class="page">
      <a routerLink="/browse">Back</a>
      <h1>Reader</h1>
      @if (!modules.reader()) {
        <p class="muted">
          Reader is off. Turn it on in <a routerLink="/settings">Settings</a>, Modules.
        </p>
      }
      <p class="refresh">
        <button
          type="button"
          [disabled]="refreshing() || !reader.feeds().length"
          (click)="refresh()"
        >
          {{ refreshing() ? 'Refreshing…' : 'Refresh' }}
        </button>
        <span class="muted">The server looks at every feed on its own, every quarter hour.</span>
      </p>
      @if (refreshed()) {
        <p class="status" role="status">{{ refreshed() }}</p>
      }
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
        }
      }
      @if (reader.loaded() && reader.feeds().length === 0) {
        <p class="muted">
          No feeds yet. <a routerLink="/reader/feeds">Import a file from your reader</a>, or follow
          one there.
        </p>
      }
      @if (items.listening().length) {
        <section aria-labelledby="listening">
          <h2 id="listening">Continue listening</h2>
          <ul class="listening" aria-label="Continue listening">
            @for (ep of items.listening(); track ep.id) {
              <li>
                <a [routerLink]="['/reader/a', ep.id]" [queryParams]="{ in: shelf }">
                  <span class="title">{{ ep.title }}</span>
                  <span class="count">{{ left(ep) }}</span>
                </a>
              </li>
            }
          </ul>
        </section>
      }
      <nav aria-label="Folders">
        <ul>
          <li>
            <a [routerLink]="['/reader/f', all]"
              >All <span class="count">{{ unread(all) }}</span></a
            >
          </li>
          <li>
            <a [routerLink]="['/reader/f', saved]"
              >Saved <span class="count">{{ unread(saved) }}</span></a
            >
          </li>
          @if (hasPodcasts()) {
            <li>
              <a [routerLink]="['/reader/f', podcasts]"
                >Podcasts <span class="count">{{ unread(podcasts) }}</span></a
              >
            </li>
          }
          @for (folder of reader.folders(); track folder.name) {
            <li>
              <a [routerLink]="['/reader/f', folder.name]"
                >{{ folder.name }} <span class="count">{{ unread(folder.name) }}</span></a
              >
            </li>
          }
        </ul>
      </nav>
      @if (showDownloads()) {
        <p class="more">
          <a routerLink="/reader/downloads">Downloads</a>
          <span class="muted">{{ downloadsText() }}</span>
        </p>
      }
      <p class="more">
        <a routerLink="/reader/feeds">Manage feeds</a>
        <span class="muted">import, follow, move, remove</span>
      </p>
    </main>
  `,
  styles: `
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    nav li,
    .listening li,
    .hits li {
      border-bottom: 1px solid var(--rule);
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
    h2 {
      margin: var(--space-3) 0 0;
      font-size: 16px;
    }
    .listening a,
    .hits a {
      display: grid;
      gap: 2px;
      padding: 10px 4px;
      color: var(--ink);
      text-decoration: none;
      font-weight: 600;
    }
    .listening .title,
    .hits .title {
      overflow-wrap: anywhere;
    }
    nav a {
      display: flex;
      justify-content: space-between;
      gap: var(--space-2);
      padding: 12px 4px;
      color: var(--ink);
      text-decoration: none;
      font-weight: 600;
    }
    .count,
    .muted,
    .status {
      color: var(--quiet);
      font-size: 14px;
      font-weight: 400;
    }
    .refresh,
    .more {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    .more {
      margin-top: var(--space-4);
    }
  `,
})
export class Reader {
  protected readonly reader = inject(ReaderService);
  protected readonly items = inject(ItemsService);
  protected readonly modules = inject(ModulesService);
  private readonly downloads = inject(DownloadsService);
  private readonly prefs = inject(DownloadPrefs);
  protected readonly all = ALL;
  protected readonly saved = SAVED;
  protected readonly podcasts = PODCASTS;
  /** Continue listening opens an episode among the podcasts (#179). */
  protected readonly shelf = `f:${PODCASTS}`;
  /** Whether any feed followed is a podcast, for the Podcasts shelf (#178). */
  protected readonly hasPodcasts = computed(() =>
    this.reader.feeds().some((f) => f.kind === 'podcast'),
  );
  /** Whether to link Downloads (#180). */
  protected readonly showDownloads = computed(
    () => this.downloads.list().length > 0 || this.prefs.keepsAny(),
  );
  /** "2 episodes, 84 MB", for the link. */
  protected readonly downloadsText = computed(() => {
    const n = this.downloads.list().length;
    if (!n) return 'none yet';
    return `${n} ${n === 1 ? 'episode' : 'episodes'}, ${size(this.downloads.total())}`;
  });
  protected readonly refreshing = signal(false);
  protected readonly refreshed = signal('');
  /** Search across every article (#175): what the last search found, and what it said. */
  protected readonly searching = signal(false);
  protected readonly hits = signal<SearchHit[] | undefined>(undefined);
  protected readonly searchSaid = signal('');

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
      const found = await this.reader.search(text);
      if (typeof found === 'string') {
        this.hits.set(undefined);
        this.searchSaid.set(found);
      } else {
        this.hits.set(found);
        if (!found.length) this.searchSaid.set('Nothing found.');
      }
    } finally {
      this.searching.set(false);
    }
  }

  /** The feed's name, for a row. */
  protected sourceOf(hit: SearchHit): string {
    return this.reader.feeds().find((f) => f.id === hit.feedId)?.title ?? 'Unknown feed';
  }

  /** "12:34 of 42:10", for Continue listening (#179). */
  protected left(ep: ItemRecord): string {
    const at = this.items.clock(ep.position ?? 0);
    const total = ep.enclosure?.seconds;
    return total ? `${at} of ${this.items.clock(total)}` : at;
  }

  /** "12 unread", or nothing when none. */
  protected unread(folder: string): string {
    const n = this.items.unreadCounts()[folder] ?? 0;
    return n ? `${n} unread` : '';
  }

  protected async refresh(): Promise<void> {
    this.refreshing.set(true);
    this.refreshed.set('');
    try {
      this.refreshed.set(await this.reader.refresh());
    } finally {
      this.refreshing.set(false);
    }
  }
}
