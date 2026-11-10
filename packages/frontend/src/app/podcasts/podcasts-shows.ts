import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { Icon } from '../home/icon';
import { ItemsService } from '../reader/items.service';
import { ReaderService } from '../reader/reader.service';
import { PodcastsBar } from './podcasts-bar';
import { ShowArt } from './show-art';
import {
  NO_FOLDER,
  type ShowSummary,
  folderName,
  inFolder,
  showFolders,
  showSummaries,
} from './shows';

/**
 * Shows (#246, step 2 of #244; Eric 2026-11-10: "A squares view for
 * listing podcasts"): a grid of squares three across, each show's
 * artwork alone (its name drawn on the tinted square when it has
 * none), its name the link's, opening its page (`/podcasts/s/<id>`),
 * with how many of its episodes at hand are unheard; newest episode
 * first. Folder chips above filter it (`?folder=`, so the folder view
 * can open one), and a button switches to the shows by folder. A
 * show's More is on its page: a long list of menus is not wanted here.
 * Refresh asks the server to look at every feed now.
 */
@Component({
  selector: 'app-podcasts-shows',
  imports: [Icon, PodcastsBar, RouterLink, ShowArt],
  template: `
    <main class="page">
      <app-podcasts-bar active="shows" />
      <h2 class="visually-hidden">Shows</h2>
      @if (shows().length) {
        <div class="chips">
          <div class="choices" role="group" aria-label="Folders">
            <button
              type="button"
              [attr.aria-pressed]="folder() === undefined ? 'true' : 'false'"
              (click)="choose(undefined)"
            >
              All <span class="count">{{ shows().length }}</span>
            </button>
            @for (f of chips(); track f) {
              <button
                type="button"
                [attr.aria-pressed]="folder() === f ? 'true' : 'false'"
                (click)="choose(f)"
              >
                {{ name(f) }}
              </button>
            }
          </div>
          <a class="icon" routerLink="/podcasts/folders" aria-label="Shows by folder">
            <app-icon name="folder" [size]="22" />
          </a>
        </div>
        <p class="line">{{ line() }}</p>
      }
      <ul class="grid" aria-label="Shows">
        @for (s of shown(); track s.feed.id) {
          <li>
            <a [routerLink]="['/podcasts/s', s.feed.id]" [attr.aria-label]="label(s)">
              <app-show-art [id]="s.feed.id" [title]="s.feed.title" [src]="s.art" [named]="true" />
            </a>
            @if (s.unheard) {
              <span class="badge" aria-hidden="true">{{ s.unheard }}</span>
            }
          </li>
        }
      </ul>
      <p class="refresh">
        <button
          type="button"
          [disabled]="refreshing() || !reader.podcastFeeds().length"
          (click)="refresh()"
        >
          {{ refreshing() ? 'Refreshing…' : 'Refresh' }}
        </button>
        <span class="hint">The server looks at every show on its own, every quarter hour.</span>
      </p>
      @if (refreshed()) {
        <p class="status" role="status">{{ refreshed() }}</p>
      }
      @if (shows().length) {
        <p class="hint">Unheard counts each show's newest hundred episodes on this device.</p>
      }
    </main>
  `,
  styles: `
    .chips {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    .choices {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .choices button {
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
      overflow-wrap: anywhere;
    }
    .choices button[aria-pressed='true'] {
      font-weight: 600;
      background: var(--chip-bg);
      border-color: var(--ink);
    }
    .count {
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .icon {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border-radius: var(--radius-control);
    }
    .line,
    .status,
    .hint {
      color: var(--quiet);
      font-size: 14px;
      font-weight: 400;
    }
    .line {
      margin: var(--space-2) 0;
    }
    .grid {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .grid li {
      position: relative;
      min-width: 0;
    }
    .grid a {
      display: block;
      border-radius: var(--radius-control);
      color: var(--ink);
      text-decoration: none;
    }
    .badge {
      position: absolute;
      top: 6px;
      right: 6px;
      min-width: 22px;
      height: 22px;
      padding: 0 6px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: var(--ink);
      color: var(--surface);
      font-family: var(--font-mono);
      font-size: 12px;
      pointer-events: none;
    }
    .refresh {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      margin-top: var(--space-3);
    }
  `,
})
export class PodcastsShows {
  protected readonly reader = inject(ReaderService);
  private readonly items = inject(ItemsService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly refreshing = signal(false);
  protected readonly refreshed = signal('');
  private readonly asked = toSignal(
    this.route.queryParamMap.pipe(map((p) => p.get('folder') ?? undefined)),
    { initialValue: undefined },
  );

  /** Every show, newest episode first, with its counts and artwork. */
  protected readonly shows = computed(() =>
    showSummaries(this.reader.podcastFeeds(), this.items.episodes()),
  );
  private readonly folders = computed(() => showFolders(this.shows()));
  /**
   * The folder chips: each folder by name, then the shows in none, when
   * there are folders at all.
   */
  protected readonly chips = computed(() => {
    const names = this.folders().map((f) => f.name);
    return names.some((n) => n !== NO_FOLDER) ? names : [];
  });
  /** The folder chosen, while it still holds shows. */
  protected readonly folder = computed(() => {
    const asked = this.asked();
    return asked !== undefined && this.chips().includes(asked) ? asked : undefined;
  });
  protected readonly shown = computed(() => {
    const folder = this.folder();
    return folder === undefined ? this.shows() : this.shows().filter((s) => inFolder(s, folder));
  });
  protected readonly line = computed(() => {
    const n = this.shown().length;
    const folder = this.folder();
    const where = folder === undefined ? '' : ` in ${this.name(folder)}`;
    return `${n} ${n === 1 ? 'show' : 'shows'}${where}, newest episode first`;
  });

  protected name(folder: string): string {
    return folderName(folder);
  }

  /** The square's name: the show's, how many unheard, and whether its last look failed. */
  protected label(s: ShowSummary): string {
    const parts = [s.feed.title];
    if (s.unheard) parts.push(`${s.unheard} unheard`);
    if (s.feed.dead) parts.push('not answering');
    else if (s.feed.error) parts.push('last look failed');
    return parts.join(', ');
  }

  /** A folder chip: the grid filtered, kept in the address so Back and the folder view agree. */
  protected choose(folder: string | undefined): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { folder: folder ?? null },
      replaceUrl: true,
    });
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
