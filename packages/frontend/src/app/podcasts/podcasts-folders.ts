import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../home/icon';
import { ItemsService } from '../reader/items.service';
import { renamedFolder } from '../reader/reader-feeds';
import { ReaderService, cleanFolder } from '../reader/reader.service';
import { PodcastsBar } from './podcasts-bar';
import { ShowArt } from './show-art';
import { NO_FOLDER, folderLine, folderName, showFolders, showSummaries } from './shows';

/**
 * Shows by folder (#246; Eric 2026-11-10: "A folder view like the text
 * feed for if I get a _lot_ of podcasts"), at `/podcasts/folders`
 * under the Shows tab: one section per folder, its name and "4 shows ·
 * 9 unheard" opening the grid filtered to it, then a strip of smaller
 * squares that scrolls sideways when long; the shows in no folder
 * last. Folders are the Reader's model, a feed's `folders` (#159), with
 * its naming rules (#185): a folder is a name some shows carry, so New
 * folder names one and puts the shows chosen in it.
 */
@Component({
  selector: 'app-podcasts-folders',
  imports: [Icon, PodcastsBar, RouterLink, ShowArt],
  template: `
    <main class="page">
      <app-podcasts-bar active="shows" current="true" />
      <h2 class="visually-hidden">Shows by folder</h2>
      @if (shows().length) {
        <div class="top">
          <p class="line">{{ line() }}</p>
          <button
            type="button"
            [attr.aria-expanded]="making()"
            aria-controls="new-folder"
            (click)="making.set(!making())"
          >
            New folder
          </button>
          <a class="icon" routerLink="/podcasts/shows" aria-label="Shows as one grid">
            <app-icon name="grid" [size]="22" />
          </a>
        </div>
        @if (making()) {
          <form id="new-folder" class="new" novalidate (submit)="make($event)">
            <label class="field">
              Folder name
              <input
                #name
                enterkeyhint="done"
                [value]="newName()"
                (input)="newName.set(name.value)"
              />
            </label>
            <fieldset>
              <legend>Put in it</legend>
              @for (s of shows(); track s.feed.id) {
                <label class="pick">
                  <input
                    type="checkbox"
                    [checked]="picked().has(s.feed.id)"
                    (change)="pick(s.feed.id, $any($event.target).checked)"
                  />
                  {{ s.feed.title }}
                </label>
              }
            </fieldset>
            <button type="submit" [disabled]="!newName().trim() || !picked().size">
              Make the folder
            </button>
          </form>
        }
        @if (said()) {
          <p class="status" role="status">{{ said() }}</p>
        }
      }
      @for (f of folders(); track f.name) {
        <section [attr.aria-label]="name(f.name)">
          <a class="head" routerLink="/podcasts/shows" [queryParams]="{ folder: f.name }">
            <span class="name">{{ name(f.name) }}</span>
            <span class="meta">{{ line2(f) }}</span>
            <app-icon name="chevron" [size]="18" />
          </a>
          <ul class="strip" [attr.aria-label]="'Shows in ' + name(f.name)">
            @for (s of f.shows; track s.feed.id) {
              <li>
                <a [routerLink]="['/podcasts/s', s.feed.id]" [attr.aria-label]="s.feed.title">
                  <app-show-art [id]="s.feed.id" [title]="s.feed.title" [src]="s.art" [size]="72" />
                </a>
              </li>
            }
          </ul>
        </section>
      }
    </main>
  `,
  styles: `
    .top {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    .line {
      flex: 1;
      margin: 0;
    }
    .top button {
      min-height: 44px;
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
    .meta,
    .status {
      color: var(--quiet);
      font-size: 14px;
      font-weight: 400;
    }
    .new {
      display: grid;
      gap: var(--space-2);
      margin-top: var(--space-2);
      padding: var(--space-2) 12px;
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-card);
    }
    .field {
      display: grid;
      gap: 4px;
    }
    .field input {
      min-height: 44px;
      font: inherit;
    }
    fieldset {
      display: grid;
      gap: 2px;
      margin: 0;
      padding: 0;
      border: 0;
    }
    legend {
      padding: 0;
      margin-bottom: 4px;
    }
    .pick {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: 44px;
      overflow-wrap: anywhere;
    }
    .new button {
      justify-self: start;
      min-height: 44px;
    }
    section {
      display: grid;
      gap: 4px;
      padding: var(--space-2) 0 10px;
      border-bottom: 1px solid var(--rule);
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: 44px;
      color: var(--ink);
      text-decoration: none;
    }
    .name {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .head .meta {
      flex: 1;
    }
    .strip {
      list-style: none;
      margin: 0;
      padding: 2px 0 6px;
      display: flex;
      gap: 8px;
      overflow-x: auto;
      overscroll-behavior-x: contain;
    }
    .strip li {
      flex: none;
    }
    .strip a {
      display: block;
      border-radius: var(--radius-control);
    }
  `,
})
export class PodcastsFolders {
  protected readonly reader = inject(ReaderService);
  private readonly items = inject(ItemsService);
  protected readonly making = signal(false);
  protected readonly newName = signal('');
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  protected readonly said = signal('');

  protected readonly shows = computed(() =>
    showSummaries(this.reader.podcastFeeds(), this.items.episodes()),
  );
  protected readonly folders = computed(() => showFolders(this.shows()));
  protected readonly line = computed(() => {
    const n = this.shows().length;
    const folders = this.folders().filter((f) => f.name !== NO_FOLDER).length;
    return `${n} ${n === 1 ? 'show' : 'shows'} in ${folders} ${folders === 1 ? 'folder' : 'folders'}`;
  });

  protected name(folder: string): string {
    return folderName(folder);
  }

  protected line2(folder: Parameters<typeof folderLine>[0]): string {
    return folderLine(folder);
  }

  protected pick(id: string, on: boolean): void {
    const next = new Set(this.picked());
    if (on) next.add(id);
    else next.delete(id);
    this.picked.set(next);
  }

  /**
   * New folder: the name kept as the Reader keeps one (#185: a special
   * shelf's name becomes "<name> (folder)"), added to each show chosen,
   * which stays in its other folders. Through the cache, offline too.
   */
  protected make(event: Event): void {
    event.preventDefault();
    const typed = this.newName();
    const folder = cleanFolder(typed);
    const ids = [...this.picked()];
    if (!folder || !ids.length) return;
    for (const id of ids) {
      const feed = this.reader.podcastFeeds().find((f) => f.id === id);
      if (feed && !feed.folders.includes(folder)) {
        this.reader.setFolders(id, [...feed.folders, folder]);
      }
    }
    const n = ids.length;
    this.said.set(
      renamedFolder([typed]) || `${folder} holds ${n} ${n === 1 ? 'show' : 'shows'} now.`,
    );
    this.making.set(false);
    this.newName.set('');
    this.picked.set(new Set());
  }
}
