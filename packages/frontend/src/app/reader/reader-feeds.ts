import { Component, type ElementRef, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FEED_CAP } from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { type DiscoveredFeed, type FeedRecord, ReaderService } from './reader.service';

/**
 * Manage feeds (#159, step 1): the feeds followed, in folders, imported
 * from an OPML file (Feedly exports one) or followed one at a time,
 * moved between folders and removed. Reading is on `/reader` (#162).
 * A site's address finds its feeds (#174): Find feeds, or Find feeds on
 * a followed link the server could not read as one, lists what the
 * server found to pick from.
 */
@Component({
  selector: 'app-reader-feeds',
  imports: [RouterLink],
  template: `
    <main class="page">
      <a routerLink="/reader">Back</a>
      <h1>Manage feeds</h1>
      @if (!modules.reader()) {
        <p class="muted">
          Reader is off. Turn it on in <a routerLink="/settings">Settings</a>, Modules.
        </p>
      }

      <h2 id="folders">Folders</h2>
      @if (reader.loaded() && reader.feeds().length === 0) {
        <p class="muted">No feeds yet. Import a file from your reader, or follow one below.</p>
      }
      <ul class="folders" aria-labelledby="folders">
        @for (folder of reader.folders(); track folder.name) {
          <li>
            <details>
              <summary>
                {{ folder.name }}
                <span class="count"
                  >{{ folder.feeds.length }}
                  {{ folder.feeds.length === 1 ? 'feed' : 'feeds' }}</span
                >
              </summary>
              <ul class="feeds" [attr.aria-label]="'Feeds in ' + folder.name">
                @for (feed of folder.feeds; track feed.id) {
                  <li>
                    <span class="name">{{ feed.title }}</span>
                    <span class="meta">{{ meta(feed) }}</span>
                    @if (notAFeed(feed)) {
                      <button
                        type="button"
                        class="find"
                        [attr.aria-label]="'Find feeds at the site of ' + feed.title"
                        [disabled]="finding()"
                        (click)="findFor(feed)"
                      >
                        Find feeds there
                      </button>
                    }
                    <label class="move">
                      <span class="visually-hidden"
                        >Folders for {{ feed.title }}, comma separated</span
                      >
                      <input
                        [value]="feed.folders.join(', ')"
                        placeholder="Folders, comma separated"
                        enterkeyhint="done"
                        (change)="move(feed, $any($event.target).value)"
                      />
                    </label>
                    @if (feed.dead || feed.error) {
                      <button
                        type="button"
                        class="retry"
                        [attr.aria-label]="'Try again: ' + feed.title"
                        (click)="reader.retry(feed.id)"
                      >
                        Try again
                      </button>
                    }
                    <button
                      type="button"
                      class="remove"
                      [attr.aria-label]="'Remove: ' + feed.title"
                      (click)="reader.removeFeed(feed.id)"
                    >
                      Remove
                    </button>
                  </li>
                }
              </ul>
            </details>
          </li>
        }
      </ul>

      <h2 id="import">Import feeds</h2>
      <p class="muted">
        An OPML file, as Feedly exports (Organize, Export OPML). Feeds already followed are kept and
        gain the file's folders; at most {{ cap }} feeds.
      </p>
      <label class="file">
        Choose an OPML file
        <input
          type="file"
          accept=".opml,.xml,text/xml,application/xml,text/x-opml"
          [disabled]="!reader.loaded()"
          (change)="importFile($any($event.target))"
        />
      </label>
      @if (imported()) {
        <p class="status" role="status">{{ imported() }}</p>
      }

      <h2 id="follow">Follow a feed</h2>
      <form novalidate class="follow" (submit)="follow($event, url, folder)">
        <label>
          <span class="visually-hidden">Feed link</span>
          <input #url type="url" inputmode="url" placeholder="https://…/feed" enterkeyhint="next" />
        </label>
        <label>
          <span class="visually-hidden">Folder</span>
          <input
            #folder
            list="reader-folders"
            placeholder="Folder (optional)"
            enterkeyhint="done"
          />
        </label>
        <datalist id="reader-folders">
          @for (name of reader.folderNames(); track name) {
            <option [value]="name"></option>
          }
        </datalist>
        <button type="submit" [disabled]="!reader.loaded()">Follow</button>
        <button type="button" [disabled]="!reader.loaded() || finding()" (click)="find()">
          Find feeds
        </button>
      </form>
      <p class="muted">Not a feed's link? Paste the site's address and choose Find feeds.</p>
      @if (followed()) {
        <p class="status" role="status">{{ followed() }}</p>
      }
      @if (candidates().length) {
        <ul class="candidates" aria-label="Feeds found">
          @for (c of candidates(); track c.url) {
            <li>
              <span class="name">{{ c.title }}</span>
              <span class="meta"
                >{{ c.url }}{{ reader.followed(c.url) ? ' · already followed' : '' }}</span
              >
              <button
                type="button"
                class="pick"
                [attr.aria-label]="'Follow: ' + c.title"
                (click)="followFound(c)"
              >
                Follow
              </button>
            </li>
          }
        </ul>
      }
    </main>
  `,
  styles: `
    h2 {
      margin-top: var(--space-4);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .folders > li {
      border-bottom: 1px solid var(--rule);
    }
    summary {
      padding: 10px 4px;
      cursor: pointer;
      font-weight: 600;
    }
    .count,
    .meta,
    .muted,
    .status {
      color: var(--quiet);
      font-size: 14px;
      font-weight: 400;
    }
    .feeds li {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 2px var(--space-2);
      padding: 8px 4px 10px 16px;
      border-top: 1px solid var(--rule);
    }
    .name {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .meta {
      grid-column: 1;
    }
    .move {
      grid-column: 1;
    }
    .remove,
    .retry {
      grid-column: 2;
      align-self: center;
      min-height: 32px;
    }
    .remove {
      grid-row: 1 / span 3;
    }
    .retry {
      grid-row: 1;
    }
    .retry + .remove {
      grid-row: 2 / span 2;
    }
    .find {
      grid-column: 1;
      justify-self: start;
      min-height: 32px;
    }
    .candidates li {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 2px var(--space-2);
      padding: 8px 4px 10px;
      border-top: 1px solid var(--rule);
    }
    .candidates .meta {
      overflow-wrap: anywhere;
    }
    .pick {
      grid-column: 2;
      grid-row: 1 / span 2;
      align-self: center;
      min-height: 32px;
    }
  `,
})
export class ReaderFeeds {
  protected readonly reader = inject(ReaderService);
  protected readonly modules = inject(ModulesService);
  protected readonly cap = FEED_CAP;
  protected readonly imported = signal('');
  protected readonly followed = signal('');
  /** What Find feeds turned up (#174), to pick from. */
  protected readonly candidates = signal<DiscoveredFeed[]>([]);
  protected readonly finding = signal(false);
  private readonly urlInput = viewChild.required<ElementRef<HTMLInputElement>>('url');
  private readonly folderInput = viewChild.required<ElementRef<HTMLInputElement>>('folder');
  protected async importFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    let out;
    try {
      out = this.reader.importOpml(await file.text());
    } catch (err) {
      console.error('OPML not read', err);
      this.imported.set('That file could not be read.');
      return;
    }
    if (!out) {
      this.imported.set('No feeds found in that file. It wants an OPML export.');
      return;
    }
    const parts = [`${out.added} ${out.added === 1 ? 'feed' : 'feeds'} added`];
    if (out.known) parts.push(`${out.known} already followed`);
    if (out.refused) parts.push(`${out.refused} left out past the ${FEED_CAP} cap`);
    this.imported.set(`${parts.join(', ')}. New articles arrive once the server has looked.`);
  }

  protected follow(event: Event, url: HTMLInputElement, folder: HTMLInputElement): void {
    event.preventDefault();
    if (!url.value.trim()) return;
    const id = this.reader.addFeed(url.value, folder.value);
    if (!id) {
      this.followed.set(
        this.reader.feeds().length >= FEED_CAP
          ? `That is ${FEED_CAP} feeds already; remove one first.`
          : 'That is not a link. Paste one starting with https://.',
      );
      return;
    }
    url.value = '';
    this.candidates.set([]);
    this.followed.set('Following. Its name and articles arrive once the server has looked.');
  }

  /** Asks the server for the feeds at the pasted address (#174). */
  protected async find(): Promise<void> {
    const text = this.urlInput().nativeElement.value.trim();
    if (!text) {
      this.followed.set('Paste a site’s address first.');
      return;
    }
    this.finding.set(true);
    this.candidates.set([]);
    this.followed.set('Looking for feeds…');
    const found = await this.reader.discover(text);
    this.finding.set(false);
    if (typeof found === 'string') {
      this.followed.set(found);
      return;
    }
    this.candidates.set(found);
    this.followed.set(
      found.length === 1
        ? 'Found a feed; follow it below.'
        : `Found ${found.length} feeds; pick one below.`,
    );
  }

  /** Find feeds for a followed link the server could not read as a feed (#174). */
  protected findFor(feed: FeedRecord): void {
    this.urlInput().nativeElement.value = feed.site ?? feed.url;
    this.folderInput().nativeElement.value = feed.folders[0] ?? '';
    void this.find();
  }

  protected followFound(found: DiscoveredFeed): void {
    const folder = this.folderInput().nativeElement.value.trim();
    const known = this.reader.followed(found.url);
    if (!this.reader.addFeed(found.url, folder, found.title)) {
      this.followed.set(`That is ${FEED_CAP} feeds already; remove one first.`);
      return;
    }
    this.urlInput().nativeElement.value = '';
    this.candidates.set([]);
    this.followed.set(
      known
        ? `Already following ${known.title}${folder ? `; now in ${folder} too` : ''}.`
        : `Following ${found.title}. Its articles arrive once the server has looked.`,
    );
  }

  /** The server looked and found a page, not a feed (#161's message). */
  protected notAFeed(feed: FeedRecord): boolean {
    return !feed.dead && /^not a feed/.test(feed.error ?? '');
  }

  protected move(feed: FeedRecord, value: string): void {
    this.reader.setFolders(feed.id, value.split(','));
  }

  protected meta(feed: FeedRecord): string {
    let host = feed.url;
    try {
      host = new URL(feed.site ?? feed.url).hostname;
    } catch {
      // The link as it is, then.
    }
    // A podcast says so first (#178).
    if (feed.kind === 'podcast') host = `${host} · podcast`;
    if (feed.dead) return `${host} · not answering for a month, given up`;
    if (feed.error) return `${host} · last look failed: ${feed.error}`;
    if (feed.fetchedAt === undefined) return `${host} · not looked at yet`;
    const ago = Math.max(0, Math.round((Date.now() - feed.fetchedAt) / 60_000));
    return `${host} · looked ${ago < 1 ? 'just now' : ago < 60 ? `${ago} min ago` : `${Math.round(ago / 60)} h ago`}`;
  }
}
