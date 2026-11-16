import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ItemsService } from './items.service';
import { ReaderArticle } from './reader-article';
import { type FolderChip, ReaderBar, folderChips } from './reader-bar';
import { ReaderDone } from './reader-done';
import { ReaderList, sameShelf, shelfFromParam, tabOf } from './reader-list';
import { ReaderService } from './reader.service';
import { ALL, SAVED, type Shelf2 } from './shelves';

/** What the panes show for an address: the list's shelf, and the article or the caught-up page. */
export interface PanesPlace {
  shelf: Shelf2;
  /** The article open in the article pane. */
  article?: string;
  /** The caught-up page is in the article pane. */
  done: boolean;
}

/**
 * Reads the panes' address (#289), its path after `/reader` and its
 * `in`: a folder's or a feed's list with no article, or an article or
 * the caught-up page beside the list it was opened from, which `in`
 * names, as it always has for next and previous.
 */
export function panesPlace(path: readonly string[], inParam: string | null): PanesPlace {
  const [kind, value] = path;
  if (kind === 'f' && value !== undefined)
    return { shelf: { kind: 'folder', name: value }, done: false };
  if (kind === 's' && value !== undefined)
    return { shelf: { kind: 'feed', id: value }, done: false };
  if (kind === 'a' && value !== undefined) {
    return { shelf: shelfFromParam(inParam), article: value, done: false };
  }
  if (kind === 'done') return { shelf: shelfFromParam(inParam), done: true };
  return { shelf: { kind: 'folder', name: ALL }, done: false };
}

/**
 * The folders pane's links (#289): All, Saved, then the folders with
 * feeds in them in the Reader's order, each with what is unread in it,
 * as the chips have them (#288). `current` is the shelf shown; a
 * feed's own list marks none.
 */
export function panesFolders(
  folders: readonly { name: string }[],
  counts: Readonly<Record<string, number>>,
  shelf: Shelf2,
): FolderChip[] {
  const current = shelf.kind === 'folder' ? shelf.name : undefined;
  const [all, ...rest] = folderChips(folders, counts, current);
  const saved = { name: 'Saved', link: ['/reader/f', SAVED], count: 0, current: current === SAVED };
  return [all, saved, ...rest];
}

/**
 * The Reader in three panes (#289, part 3 of the desktop shell, Eric's
 * decision of 2026-11-15), from READER_PANES_MIN: under the Reader's
 * header, the folders, the list and the article, each scrolling on its
 * own. One route for `/reader`, a folder's or a feed's list, an article
 * and the caught-up page (`readerPanesMatcher`), so the router keeps
 * this screen, and the list in it, as an article opens: the list is not
 * drawn again and keeps its place. The address stays the truth: an
 * article's list is the one its `in` names. With no article the pane
 * says to choose one.
 */
@Component({
  selector: 'app-reader-panes',
  imports: [ReaderArticle, ReaderBar, ReaderDone, ReaderList, RouterLink],
  template: `
    <main class="panes">
      <!-- The header and tabs across the panes; the folders pane stands for the chips. -->
      <app-reader-bar
        class="head"
        [active]="tab()"
        [current]="tab() === 'folders' ? 'true' : 'page'"
      />
      <nav class="folders" aria-label="Folders">
        <ul>
          @for (place of folders(); track place.name) {
            <li>
              <!-- Named "Design 3 unread", shown "Design 3". -->
              <a [routerLink]="place.link" [attr.aria-current]="place.current ? 'page' : null"
                ><span class="name">{{ place.name }}</span>
                @if (place.count) {
                  <span class="count">{{ ' ' + place.count }}</span
                  ><span class="visually-hidden"> unread</span>
                }
              </a>
            </li>
          }
        </ul>
      </nav>
      <section class="list" aria-label="List of articles">
        <app-reader-list
          #list
          pane
          [shelf]="shelf()"
          [current]="article()"
          [ownKeys]="!article() && !done()"
        />
      </section>
      <section class="article" aria-label="Article">
        @if (article()) {
          <app-reader-article pane [order]="list.drawn()" [opening]="settled()" />
        } @else if (done()) {
          <app-reader-done pane />
        } @else {
          <p class="empty">Choose an article</p>
        }
      </section>
    </main>
  `,
  styles: `
    :host {
      display: block;
    }
    /*
     * The rail 176 (the body's padding), then the folders 192 and the
     * list 352, and the article in what is left: at READER_PANES_MIN,
     * 1320, that is 600, its text 70 characters with 16 px either side.
     * The page is the window's height, less the mini-player, so it never
     * scrolls; each pane does, on its own.
     */
    .panes {
      display: grid;
      grid-template-columns: 192px 352px minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
      grid-template-areas: 'head head head' 'folders list article';
      box-sizing: border-box;
      height: calc(100dvh - var(--mini-player-height, 0px));
    }
    .head {
      grid-area: head;
      box-sizing: border-box;
      /* A long search's results scroll here, not over the panes. */
      max-height: 45dvh;
      overflow-y: auto;
      padding: var(--space-3) var(--space-3) var(--space-2);
      margin: 0;
      border-bottom: 1px solid var(--rule);
    }
    .folders,
    .list,
    .article {
      box-sizing: border-box;
      min-width: 0;
      min-height: 0;
    }
    .folders {
      grid-area: folders;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: var(--space-2);
      border-right: 1px solid var(--rule);
    }
    .list {
      grid-area: list;
      border-right: 1px solid var(--rule);
    }
    .article {
      grid-area: article;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .folders a {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      min-height: 36px;
      padding: 6px 10px;
      border-radius: var(--radius-control);
      color: var(--ink);
      text-decoration: none;
    }
    .folders a[aria-current] {
      font-weight: 600;
      background: var(--chip-bg);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .name {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .count {
      flex: none;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--quiet);
    }
    .folders a[aria-current] .count {
      color: var(--ink);
    }
    .empty {
      margin: var(--space-4) var(--space-3);
      text-align: center;
      color: var(--quiet);
    }
  `,
})
export class ReaderPanes {
  private readonly reader = inject(ReaderService);
  private readonly items = inject(ItemsService);
  private readonly route = inject(ActivatedRoute);
  private readonly url = toSignal(this.route.url, { initialValue: [] });
  private readonly query = toSignal(this.route.queryParamMap);
  private readonly place = computed(() =>
    panesPlace(
      this.url()
        .slice(1)
        .map((s) => s.path),
      this.query()?.get('in') ?? null,
    ),
  );
  /** The list's shelf: the same object while it is the same list, so the list keeps its state. */
  protected readonly shelf = computed(() => this.place().shelf, { equal: sameShelf });
  protected readonly article = computed(() => this.place().article);
  protected readonly done = computed(() => this.place().done);
  protected readonly tab = computed(() => tabOf(this.shelf()));
  protected readonly folders = computed(() =>
    panesFolders(this.reader.folders(), this.items.unreadCounts(), this.shelf()),
  );
  /**
   * Drawn once: from then an article arriving in the pane is one the
   * gardener opened, and takes the focus (the article screen's own
   * arrival, which a reload or a wider window does not get).
   */
  protected readonly settled = signal(false);

  constructor() {
    afterNextRender(() => this.settled.set(true));
  }
}
