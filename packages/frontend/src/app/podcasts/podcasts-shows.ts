import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../home/icon';
import { ItemsService } from '../reader/items.service';
import { type FeedRecord, ReaderService } from '../reader/reader.service';
import { EpisodeArt } from './episode-art';
import { episodeState } from './episodes';
import { PodcastsBar } from './podcasts-bar';

/**
 * Shows (#245, step 1 of #244): the shows followed in Podcasts by name,
 * each opening its episodes (`/podcasts/s/<feedId>`), with how many are
 * new. A stand-in until step 2 makes it a grid of artwork. More on a
 * show has Move to the Reader, for a feed that is mostly writing (Eric,
 * 2026-11-10: nothing moves by itself, so a misfiled one is sent across
 * by hand), and Unfollow. Refresh asks the server to look at every
 * feed now, as the Reader's Folders tab does.
 */
@Component({
  selector: 'app-podcasts-shows',
  imports: [EpisodeArt, Icon, PodcastsBar, RouterLink],
  template: `
    <main class="page">
      <app-podcasts-bar active="shows" />
      <h2 class="visually-hidden">Shows</h2>
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
      <ul aria-label="Shows">
        @for (s of shows(); track s.feed.id) {
          <li>
            <div class="row">
              <app-episode-art [item]="{ feedId: s.feed.id }" [show]="s.feed.title" [size]="40" />
              <a class="open" [routerLink]="['/podcasts/s', s.feed.id]">
                <span class="name">{{ s.feed.title }}</span>
                <span class="meta">{{ s.line }}</span>
              </a>
              <button
                type="button"
                class="more"
                [attr.aria-label]="'More for ' + s.feed.title"
                [attr.aria-expanded]="open() === s.feed.id"
                (click)="open.set(open() === s.feed.id ? undefined : s.feed.id)"
              >
                <app-icon name="more" [size]="22" />
              </button>
            </div>
            @if (open() === s.feed.id) {
              <div class="menu" role="group" [attr.aria-label]="s.feed.title">
                <button type="button" (click)="toReader(s.feed)">
                  Move to the Reader
                  <span class="hint">For a feed that is mostly writing</span>
                </button>
                <button type="button" (click)="unfollow(s.feed)">Unfollow</button>
              </div>
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
    ul {
      list-style: none;
      margin: var(--space-2) 0 0;
      padding: 0;
      border-top: 1px solid var(--rule);
    }
    li {
      border-bottom: 1px solid var(--rule);
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: 8px 0;
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
    .name {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .meta,
    .status,
    .hint {
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
    .more {
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
    .more[aria-expanded='true'] {
      background: var(--chip-bg);
    }
    .menu {
      display: grid;
      gap: 4px;
      padding: 0 0 var(--space-2) 48px;
    }
    .menu button {
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
  `,
})
export class PodcastsShows {
  protected readonly reader = inject(ReaderService);
  private readonly items = inject(ItemsService);
  /** The show whose More is open. */
  protected readonly open = signal<string | undefined>(undefined);
  protected readonly said = signal('');
  protected readonly refreshing = signal(false);
  protected readonly refreshed = signal('');

  protected async refresh(): Promise<void> {
    this.refreshing.set(true);
    this.refreshed.set('');
    try {
      this.refreshed.set(await this.reader.refresh());
    } finally {
      this.refreshing.set(false);
    }
  }

  protected readonly shows = computed(() => {
    const episodes = this.items.episodes();
    return this.reader.podcastFeeds().map((feed) => {
      const own = episodes.filter((e) => e.feedId === feed.id);
      const fresh = own.filter((e) => episodeState(e) === 'new').length;
      const line = feed.dead
        ? 'Not answering, given up'
        : feed.error
          ? `Last look failed: ${feed.error}`
          : feed.fetchedAt === undefined
            ? 'Not looked at yet'
            : `${own.length} ${own.length === 1 ? 'episode' : 'episodes'} · ${fresh} new`;
      return { feed, line };
    });
  });

  /** Move to the Reader (#245): the feed's kind cleared; its articles are the Reader's now. */
  protected toReader(feed: FeedRecord): void {
    this.reader.setPodcast(feed.id, false);
    this.open.set(undefined);
    this.said.set(`${feed.title} is in the Reader now.`);
  }

  protected unfollow(feed: FeedRecord): void {
    this.reader.removeFeed(feed.id);
    this.open.set(undefined);
    this.said.set(`Unfollowed ${feed.title}.`);
  }
}
