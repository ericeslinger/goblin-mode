import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FEED_CAP } from '@mossgoblin/schema';
import { HomeLink } from '../home/home-link';
import { Icon } from '../home/icon';
import { ModulesService } from '../modules/modules.service';
import { ItemsService } from '../reader/items.service';
import { renamedFolder } from '../reader/reader-feeds';
import { type DiscoveredFeed, ReaderService, cleanFolder } from '../reader/reader.service';

/**
 * Add a podcast (#245, `/podcasts/add`): the show's feed or its site,
 * Find the feed asking the server as the Reader's discovery does
 * (#174), the feed found with its name and episodes, a folder, and New
 * episodes join the queue, off unless switched on (Eric, 2026-11-10):
 * since #249 the fetcher appends the show's new episodes to the
 * listening queue while it is on.
 * Following writes the feed with `kind: 'podcast'` and `autoQueue`,
 * through the persistent cache, offline too; without a look, the link
 * is followed as it is. A feed followed already stays where it is:
 * nothing moves by itself, so one in the Reader is moved from there.
 */
@Component({
  selector: 'app-podcasts-add',
  imports: [HomeLink, Icon, RouterLink],
  template: `
    <main class="page">
      <header class="top">
        <app-home-link />
        <a class="back" routerLink="/podcasts"
          ><app-icon name="chevron-left" [size]="18" />Podcasts</a
        >
      </header>
      <h1>Add a podcast</h1>
      @if (!modules.podcasts()) {
        <p class="muted">
          Podcasts is off. Turn it on in <a routerLink="/settings">Settings</a>, Modules.
        </p>
      }
      <form novalidate (submit)="follow($event)">
        <label class="field">
          The show's feed, or its site
          <input
            #url
            type="url"
            inputmode="url"
            autocomplete="off"
            placeholder="https://…"
            enterkeyhint="search"
            [value]="address()"
            (input)="typed(url.value)"
            (keydown.enter)="$event.preventDefault(); find()"
          />
        </label>
        <p class="row">
          <button
            type="button"
            [disabled]="!reader.loaded() || !address().trim() || finding()"
            (click)="find()"
          >
            {{ finding() ? 'Looking…' : 'Find the feed' }}
          </button>
        </p>
        @if (found().length) {
          <div class="found" role="radiogroup" aria-label="Feeds found">
            @for (c of found(); track c.url) {
              <label class="card">
                <input
                  type="radio"
                  name="found"
                  [checked]="chosen()?.url === c.url"
                  (change)="chosen.set(c)"
                />
                <span class="text">
                  <span class="name">{{ c.title }}</span>
                  <span class="meta">{{ foundLine(c) }}</span>
                </span>
              </label>
            }
          </div>
        }
        <label class="field">
          Folder
          <input
            #folder
            list="podcast-folders"
            placeholder="No folder"
            enterkeyhint="done"
            [value]="folderName()"
            (input)="folderName.set(folder.value)"
          />
        </label>
        <datalist id="podcast-folders">
          @for (name of reader.podcastFolderNames(); track name) {
            <option [value]="name"></option>
          }
        </datalist>
        <label class="switch">
          <input
            type="checkbox"
            role="switch"
            [checked]="autoQueue()"
            (change)="autoQueue.set($any($event.target).checked)"
          />
          <span class="text">
            <span>New episodes join the queue</span>
            <span class="meta">{{
              autoQueue()
                ? 'On: its new episodes go to the end of the queue'
                : 'Off: you add episodes yourself'
            }}</span>
          </span>
        </label>
        <button type="submit" class="follow" [disabled]="!reader.loaded() || !address().trim()">
          {{ chosen() ? 'Follow ' + chosen()!.title : 'Follow' }}
        </button>
      </form>
      @if (said()) {
        <p class="status" role="status">{{ said() }}</p>
      }
      @if (added(); as a) {
        <p class="muted">
          <a [routerLink]="['/podcasts/s', a.id]">{{ a.title }}</a>
          @if (a.episodes) {
            · {{ a.episodes }} {{ a.episodes === 1 ? 'episode' : 'episodes' }}
          }
        </p>
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
    form {
      display: grid;
      gap: var(--space-3);
    }
    .field {
      display: grid;
      gap: 6px;
      font-weight: 600;
    }
    .field input {
      font: inherit;
      font-weight: 400;
      min-height: 48px;
    }
    .row {
      margin: 0;
    }
    .row button,
    .follow {
      min-height: 44px;
    }
    .follow {
      font-weight: 600;
    }
    .found {
      display: grid;
      gap: var(--space-2);
    }
    .card,
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
    .name {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .meta,
    .muted,
    .status {
      color: var(--quiet);
      font-size: 14px;
      font-weight: 400;
      overflow-wrap: anywhere;
    }
  `,
})
export class PodcastsAdd {
  protected readonly reader = inject(ReaderService);
  protected readonly modules = inject(ModulesService);
  private readonly items = inject(ItemsService);
  protected readonly address = signal('');
  protected readonly folderName = signal('');
  /** New episodes join the queue: off unless switched on (Eric, 2026-11-10). */
  protected readonly autoQueue = signal(false);
  protected readonly found = signal<DiscoveredFeed[]>([]);
  protected readonly chosen = signal<DiscoveredFeed | undefined>(undefined);
  protected readonly finding = signal(false);
  protected readonly said = signal('');
  /** The show just followed, with its episodes once they are at hand. */
  private readonly addedId = signal<string | undefined>(undefined);
  protected readonly added = computed(() => {
    const id = this.addedId();
    const feed = id ? this.reader.feeds().find((f) => f.id === id) : undefined;
    if (!feed) return undefined;
    const episodes = this.items.episodes().filter((e) => e.feedId === id).length;
    return { id: feed.id, title: feed.title, episodes };
  });

  protected typed(value: string): void {
    this.address.set(value);
    // Another address: what was found was for the last one.
    this.found.set([]);
    this.chosen.set(undefined);
  }

  /** "Found its feed · 112 episodes", or the feed's link when it says no episodes. */
  protected foundLine(c: DiscoveredFeed): string {
    const followed = this.reader.followed(c.url);
    const where = followed
      ? followed.kind === 'podcast'
        ? ' · already followed here'
        : ' · already in the Reader'
      : '';
    return c.episodes
      ? `Found its feed · ${c.episodes} ${c.episodes === 1 ? 'episode' : 'episodes'}${where}`
      : `${c.url}${where}`;
  }

  /** Find the feed (#174): the server looks at the address; needs the network. */
  protected async find(): Promise<void> {
    const text = this.address().trim();
    if (!text || this.finding()) return;
    this.finding.set(true);
    this.said.set('Looking for the feed…');
    const found = await this.reader.discover(text);
    this.finding.set(false);
    if (typeof found === 'string') {
      this.found.set([]);
      this.chosen.set(undefined);
      this.said.set(found);
      return;
    }
    // Those with episodes first: this is Podcasts.
    const sorted = [...found].sort((a, b) => (b.episodes ?? 0) - (a.episodes ?? 0));
    this.found.set(sorted);
    this.chosen.set(sorted[0]);
    this.said.set(
      sorted.length === 1 ? 'Found the feed.' : `Found ${sorted.length} feeds; pick one.`,
    );
  }

  /**
   * Follows the feed found, or the link as typed when nothing was
   * looked for, as a show in Podcasts with the queue switch as set.
   */
  protected follow(event: Event): void {
    event.preventDefault();
    const pick = this.chosen();
    const link = pick?.url ?? this.address().trim();
    if (!link) return;
    const known = this.reader.followed(link);
    if (known) {
      this.said.set(
        known.kind === 'podcast'
          ? `Already following ${known.title}.`
          : `${known.title} is in the Reader; Manage feeds there can move it to Podcasts.`,
      );
      return;
    }
    const typed = this.folderName();
    const folder = cleanFolder(typed);
    const id = this.reader.addFeed(link, folder || undefined, pick?.title, {
      podcast: true,
      autoQueue: this.autoQueue(),
    });
    if (!id) {
      this.said.set(
        this.reader.feeds().length >= FEED_CAP
          ? `That is ${FEED_CAP} feeds already; unfollow one first.`
          : 'That is not a link. Paste one starting with https://.',
      );
      return;
    }
    this.addedId.set(id);
    this.address.set('');
    this.found.set([]);
    this.chosen.set(undefined);
    this.said.set(
      [
        `Following ${pick?.title ?? 'it'}. Its episodes arrive once the server has looked.`,
        renamedFolder([typed]),
      ]
        .filter(Boolean)
        .join(' '),
    );
  }
}
