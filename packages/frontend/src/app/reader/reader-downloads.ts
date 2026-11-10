import { Component, computed, inject } from '@angular/core';
import { ModulesService } from '../modules/modules.service';
import { RouterLink } from '@angular/router';
import { DownloadPrefs } from './download-prefs';
import { DownloadsService, size } from './downloads.service';
import { ReaderService } from './reader.service';

/**
 * Downloads (#180): the episodes kept on this device to play offline,
 * newest first, each with its podcast, its size and Remove, and the
 * total against the cap set in Settings, Downloads. Reached from the
 * Reader's header and Podcasts' (#245); Back goes to Podcasts while it
 * is on, the Reader otherwise, and an episode opens on its own module's
 * page.
 */
@Component({
  selector: 'app-reader-downloads',
  imports: [RouterLink],
  template: `
    <main class="page">
      <a [routerLink]="modules.podcasts() ? '/podcasts' : '/reader'">Back</a>
      <h1>Downloads</h1>
      <p class="total" role="status">{{ totalText() }}</p>
      @if (!downloads.available()) {
        <p class="muted">This browser cannot keep downloads.</p>
      } @else if (downloads.loaded() && downloads.list().length === 0) {
        <p class="muted">
          Nothing downloaded yet. An episode's page has Download; a show in
          <a routerLink="/podcasts/shows">Podcasts</a> can keep its newest downloaded.
        </p>
      }
      <ul aria-label="Downloads">
        @for (d of downloads.list(); track d.id) {
          <li>
            <a class="open" [routerLink]="pageOf(d)" [queryParams]="queryOf(d)">
              <span class="title">{{ d.title }}</span>
              <span class="meta"
                >{{ podcast(d.feedId) }} · {{ sizeOf(d.bytes)
                }}{{ d.auto ? ' · kept newest' : '' }}</span
              >
            </a>
            <button
              type="button"
              [attr.aria-label]="'Remove download: ' + d.title"
              (click)="downloads.remove(d.id)"
            >
              Remove
            </button>
          </li>
        }
      </ul>
      <p class="muted">
        Downloads stay on this device. The cap and Wi-Fi are in
        <a routerLink="/settings" fragment="downloads">Settings, Downloads</a>.
      </p>
    </main>
  `,
  styles: `
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: var(--space-2);
      align-items: center;
      border-bottom: 1px solid var(--rule);
    }
    .open {
      display: grid;
      gap: 2px;
      padding: 10px 4px;
      color: var(--ink);
      text-decoration: none;
      min-width: 0;
    }
    .title {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .meta,
    .muted,
    .total {
      color: var(--quiet);
      font-size: 14px;
    }
    button {
      min-height: 32px;
    }
  `,
})
export class ReaderDownloads {
  protected readonly downloads = inject(DownloadsService);
  private readonly prefs = inject(DownloadPrefs);
  private readonly reader = inject(ReaderService);
  protected readonly modules = inject(ModulesService);
  protected readonly sizeOf = size;

  /** "3 episodes, 120 MB of 500 MB". */
  protected readonly totalText = computed(() => {
    const n = this.downloads.list().length;
    const used = n ? size(this.downloads.total()) : '0 MB';
    const cap = `${this.prefs.capMb()} MB`;
    const count = `${n} ${n === 1 ? 'episode' : 'episodes'}`;
    return `${count}, ${used} of ${cap}`;
  });

  /** An episode's page: Podcasts' for a show followed there (#245), else the Reader's. */
  protected pageOf(d: { id: string; feedId: string }): string[] {
    return this.reader.isPodcast(d.feedId) ? ['/podcasts/e', d.id] : ['/reader/a', d.id];
  }

  protected queryOf(d: { feedId: string }): Record<string, string> | null {
    return this.reader.isPodcast(d.feedId) ? null : { in: `s:${d.feedId}` };
  }

  protected podcast(feedId: string): string {
    return (
      this.reader.feeds().find((f) => f.id === feedId)?.title ?? 'A podcast no longer followed'
    );
  }
}
