import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FEED_CAP } from '@mossgoblin/schema';
import { ModulesService } from '../modules/modules.service';
import { type FeedRecord, ReaderService } from './reader.service';

/**
 * The Reader (#159), step 1: the feeds followed, in folders, imported
 * from an OPML file (Feedly exports one) or followed one at a time,
 * moved between folders and removed. Articles arrive with the fetcher
 * (#161) and are read here from step 3 (#162).
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
        <button type="submit">Follow</button>
      </form>
      @if (followed()) {
        <p class="status" role="status">{{ followed() }}</p>
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
    .remove {
      grid-column: 2;
      grid-row: 1 / span 3;
      align-self: center;
      min-height: 32px;
    }
    input {
      box-sizing: border-box;
      width: 100%;
      font: inherit;
      padding: 8px 10px;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      color: var(--ink);
      background: var(--surface);
    }
    input[type='file'] {
      padding: 4px 0;
      border: 0;
      background: none;
    }
    .file {
      display: block;
    }
    .follow {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .follow label {
      flex: 1 1 12em;
    }
  `,
})
export class Reader {
  protected readonly reader = inject(ReaderService);
  protected readonly modules = inject(ModulesService);
  protected readonly cap = FEED_CAP;
  protected readonly imported = signal('');
  protected readonly followed = signal('');

  protected async importFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    const text = await file.text();
    const out = this.reader.importOpml(text);
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
    this.followed.set('Following. Its name and articles arrive once the server has looked.');
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
    if (feed.dead) return `${host} · not answering for a month, given up`;
    if (feed.error) return `${host} · last look failed: ${feed.error}`;
    if (feed.fetchedAt === undefined) return `${host} · not looked at yet`;
    return host;
  }
}
