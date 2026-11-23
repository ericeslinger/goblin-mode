import { Component, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { Reader } from './reader';
import { ReaderArticle } from './reader-article';
import { ReaderBar } from './reader-bar';
import { ReaderDone } from './reader-done';
import { ReaderList, sameShelf, shelfFromParam, shelfTitle, tabOf } from './reader-list';
import { ReaderService } from './reader.service';
import { ALL, type Shelf2 } from './shelves';

/** What the panes show for an address: the list's shelf, and the article or the caught-up page. */
export interface PanesPlace {
  shelf: Shelf2;
  /** The article open in the article pane. */
  article?: string;
  /** The caught-up page is in the article pane. */
  done: boolean;
  /** The list pane shows the folders, the Folders tab's screen (2026-11-22). */
  folders?: boolean;
}

/**
 * Reads the panes' address (#289), its path after `/reader` and its
 * `in`: a folder's or a feed's list with no article, or an article or
 * the caught-up page beside the list it was opened from, which `in`
 * names, as it always has for next and previous; or, since
 * 2026-11-22, `/reader/folders`, the folders in the list pane.
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
  if (kind === 'folders')
    return { shelf: { kind: 'folder', name: ALL }, done: false, folders: true };
  return { shelf: { kind: 'folder', name: ALL }, done: false };
}

/**
 * The Reader in panes (#289, part 3 of the desktop shell, Eric's
 * decision of 2026-11-15), from READER_PANES_MIN: built as three (the
 * folders, the list, the article, under the Reader's header), two
 * since 2026-11-22 (Eric: "too many columns"). The list pane holds the
 * Reader's header and tabs over the list, and the article pane the
 * rest of the width, the window's height. The folders went to the
 * Folders tab: it shows them in the list pane (`/reader/folders`), and
 * a folder chosen there is the list, the tab named for it. One route
 * for `/reader`, Folders, a folder's or a feed's list, an article and
 * the caught-up page (`readerPanesMatcher`), so the router keeps this
 * screen, and the list in it, as an article opens: the list is not
 * drawn again and keeps its place. The address stays the truth: an
 * article's list is the one its `in` names. With no article the pane
 * says to choose one.
 */
@Component({
  selector: 'app-reader-panes',
  imports: [Reader, ReaderArticle, ReaderBar, ReaderDone, ReaderList],
  template: `
    <main class="panes">
      <div class="side">
        <!-- The header and tabs over the list; the Folders tab named for the list under it. -->
        <app-reader-bar
          class="head"
          [active]="tab()"
          [current]="tab() === 'folders' && !folders() ? 'true' : 'page'"
          [place]="place()"
        />
        @if (folders()) {
          <section class="list" aria-label="Folders">
            <app-reader pane [arriving]="settled()" />
          </section>
        } @else {
          <section class="list" aria-label="List of articles">
            <app-reader-list
              pane
              [shelf]="shelf()"
              [current]="article()"
              [ownKeys]="!article() && !done()"
              [arriving]="settled()"
            />
          </section>
        }
      </div>
      <section class="article" aria-label="Article">
        @if (article()) {
          <app-reader-article pane [order]="list()?.drawn()" [opening]="settled()" />
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
     * The rail (the body's padding), then the list's 384 with the
     * header over it, and the article in what is left: at
     * READER_PANES_MIN, 1200, that is 640, its text 70 characters with
     * room either side (2026-11-22; three panes from 1320 until then).
     * The page is the window's height, less the mini-player, so it
     * never scrolls; each pane does, on its own.
     */
    .panes {
      display: grid;
      grid-template-columns: 384px minmax(0, 1fr);
      box-sizing: border-box;
      height: calc(100dvh - var(--mini-player-height, 0px));
    }
    .side {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      border-right: 1px solid var(--rule);
    }
    .head {
      box-sizing: border-box;
      /* A long search's results scroll here, not over the list. */
      max-height: 45dvh;
      overflow-y: auto;
      padding: var(--space-3) var(--space-3) var(--space-2);
      margin: 0;
      border-bottom: 1px solid var(--rule);
    }
    .list,
    .article {
      box-sizing: border-box;
      min-width: 0;
      min-height: 0;
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
  private readonly route = inject(ActivatedRoute);
  private readonly url = toSignal(this.route.url, { initialValue: [] });
  private readonly query = toSignal(this.route.queryParamMap);
  private readonly at = computed(() =>
    panesPlace(
      this.url()
        .slice(1)
        .map((s) => s.path),
      this.query()?.get('in') ?? null,
    ),
  );
  /** The list's shelf: the same object while it is the same list, so the list keeps its state. */
  protected readonly shelf = computed(() => this.at().shelf, { equal: sameShelf });
  protected readonly article = computed(() => this.at().article);
  protected readonly done = computed(() => this.at().done);
  /** The list pane shows the folders (2026-11-22). */
  protected readonly folders = computed(() => !!this.at().folders);
  protected readonly tab = computed(() => (this.folders() ? 'folders' : tabOf(this.shelf())));
  /** A folder's or a feed's name, for the Folders tab while its list is shown under it. */
  protected readonly place = computed(() =>
    !this.folders() && this.tab() === 'folders'
      ? shelfTitle(this.shelf(), this.reader.feeds())
      : undefined,
  );
  /** The list pane's list, whose rows as drawn are the article's next and previous. */
  protected readonly list = viewChild(ReaderList);
  /**
   * Drawn once: from then an article arriving in the pane is one the
   * gardener opened, and takes the focus (the article screen's own
   * arrival, which a reload or a wider window does not get), and a
   * list or the folders arriving in the list pane are ones the
   * gardener chose.
   */
  protected readonly settled = signal(false);

  constructor() {
    afterNextRender(() => this.settled.set(true));
  }
}
