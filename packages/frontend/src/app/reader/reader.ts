import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { type ItemRecord, ItemsService, shelfParam } from './items.service';
import { ReaderBar } from './reader-bar';
import { ReaderService } from './reader.service';

/**
 * The Reader's Folders tab (`/reader/folders`; the front, #162, until
 * #220 opened the Reader on All): the folders with what is unread in
 * each, Refresh, and above them Continue listening, the episodes left
 * part-way on any device, newest first (#179): the Reader's own items
 * with audio, since the shows in Podcasts left it (#245). All and Saved
 * are tabs of their own; Search, Downloads and Manage feeds are in the
 * header (#221).
 */
@Component({
  selector: 'app-reader',
  imports: [ReaderBar, RouterLink],
  template: `
    <main class="page">
      <app-reader-bar active="folders" />
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
      @if (items.listening().length) {
        <section aria-labelledby="listening">
          <h2 id="listening">Continue listening</h2>
          <ul class="listening" aria-label="Continue listening">
            @for (ep of items.listening(); track ep.id) {
              <li>
                <a [routerLink]="['/reader/a', ep.id]" [queryParams]="{ in: shelfOf(ep) }">
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
          @for (folder of reader.folders(); track folder.name) {
            <li>
              <a [routerLink]="['/reader/f', folder.name]"
                >{{ folder.name }} <span class="count">{{ unread(folder.name) }}</span></a
              >
            </li>
          }
        </ul>
      </nav>
    </main>
  `,
  styles: `
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    nav li,
    .listening li {
      border-bottom: 1px solid var(--rule);
    }
    h2 {
      margin: var(--space-3) 0 0;
      font-size: 16px;
    }
    .listening a {
      display: grid;
      gap: 2px;
      padding: 10px 4px;
      color: var(--ink);
      text-decoration: none;
      font-weight: 600;
    }
    .listening .title {
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
    .refresh {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      margin-top: var(--space-3);
    }
  `,
})
export class Reader {
  protected readonly reader = inject(ReaderService);
  protected readonly items = inject(ItemsService);
  /** Continue listening opens an episode among its feed's (#179, #245). */
  protected shelfOf(ep: ItemRecord): string {
    return shelfParam({ kind: 'feed', id: ep.feedId });
  }
  protected readonly refreshing = signal(false);
  protected readonly refreshed = signal('');

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
