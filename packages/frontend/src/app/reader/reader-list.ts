import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { DownloadsService } from './downloads.service';
import { type ItemRecord, ItemsService } from './items.service';
import { ALL, SAVED, type Shelf2, shelfParam } from './shelves';
import { type FeedRecord, ReaderService } from './reader.service';
import { Swipe } from './swipe';
import { Icon } from '../home/icon';
import { NOW, TIME_ZONE } from '../platform/platform';
import { groupByDay } from './days';
import { ReaderDensity } from './density';
import { ReaderBar, type ReaderTab } from './reader-bar';
import { ReaderFeedHead } from './reader-feed-head';
import { SourceMarkView } from './source-mark';

/**
 * The shelf a list shows, from its route: `/reader` (All),
 * `/reader/f/<folder>` or `/reader/s/<feedId>`.
 */
export function shelfOf(params: { get(name: string): string | null }): Shelf2 {
  const feed = params.get('feedId');
  return feed ? { kind: 'feed', id: feed } : { kind: 'folder', name: params.get('folder') ?? ALL };
}

// A shelf as the article's `in` query parameter carries it; kept in
// ./shelves, since the service keys the visited articles by it (#188).
export { shelfParam };

/** How long a row stays above the top before it counts as passed (#172). */
export const PASSED_MS = 600;
/** How long the page is still before passed rows are marked. */
export const SETTLE_MS = 300;
/** How long Undo is offered for the last batch. */
export const UNDO_MS = 6000;
/** The top bar's height (#288): a day's heading above this hands over to it. */
const BAR_PX = 40;
/** What the gardener does to move the page, as against the browser restoring it. */
const INPUTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;

export function shelfFromParam(value: string | null): Shelf2 {
  if (value?.startsWith('s:')) return { kind: 'feed', id: value.slice(2) };
  if (value?.startsWith('f:')) return { kind: 'folder', name: value.slice(2) };
  return { kind: 'folder', name: ALL };
}

/** A shelf's list: `/reader/f/<folder>` or `/reader/s/<feedId>`. */
export function shelfLink(shelf: Shelf2): string[] {
  return shelf.kind === 'feed' ? ['/reader/s', shelf.id] : ['/reader/f', shelf.name];
}

/** The Reader's tab a shelf is, or is under (#220). */
export function tabOf(shelf: Shelf2): ReaderTab {
  if (shelf.kind === 'feed') return 'folders';
  if (shelf.name === ALL) return 'all';
  return shelf.name === SAVED ? 'saved' : 'folders';
}

/** A shelf's name as its list's heading shows it. */
export function shelfTitle(shelf: Shelf2, feeds: readonly FeedRecord[]): string {
  if (shelf.kind === 'feed') return feeds.find((f) => f.id === shelf.id)?.title ?? 'Feed';
  return shelf.name === ALL ? 'All' : shelf.name === SAVED ? 'Saved' : shelf.name;
}

/**
 * The compact list (#162): a folder's or a feed's articles, newest
 * first, unread unless Show read; an episode's row says so, how
 * long it is (#178) and whether it is downloaded (#180). Swipe a row left to mark it read,
 * right to save it (buttons do the same for keyboards and screen
 * readers); tap to open. On a keyboard j and k move, m marks read, s
 * saves, Enter opens.
 *
 * With Settings, Reader, Mark articles read as I scroll past them on
 * (#172), an unread row that stays above the top for a moment counts
 * as passed, and the passed ones are marked read in one batch once the
 * page is still. They stay in the list, greyed, until the list is left
 * or the shelf changes, so nothing moves under the finger; the status
 * bar at the foot of the screen offers Undo for the last batch for a
 * few seconds. Only a page the gardener has moved counts.
 *
 * Opening a folder's list notes when it was seen (#173), so Right Now
 * counts only the articles newer than that.
 *
 * Under the Reader's header and tabs (#220): All at `/reader`, Saved
 * its own tab, any other folder or a feed under
 * Folders, with a link back to them and its name. A feed's list is
 * that feed's page (2026-11-15): About this feed above its posts.
 *
 * Since #288 (2026-11-15): Comfortable or Compact, kept per device; the
 * rows under a heading per day, in the gardener's time, each day with
 * its own Mark these read (and the same Undo as the scroll's batch); a
 * mark for the feed at each row's left, except on one feed's own list;
 * and the folders as chips under the tabs, on All and a folder's list.
 * A day's heading sits in its first row's list item, above the row, so
 * the Articles list holds articles alone; the row inside the item is
 * what swipes, what the observer follows and what the cursor names.
 * A heading cannot stick from inside its item, so a bar standing for
 * it, hidden from screen readers, keeps the day being read at the top.
 */
@Component({
  selector: 'app-reader-list',
  imports: [Icon, ReaderBar, ReaderFeedHead, RouterLink, SourceMarkView, Swipe],
  template: `
    <main class="page">
      <app-reader-bar
        [active]="tab()"
        [current]="tab() === 'folders' ? 'true' : 'page'"
        [folder]="chipFolder()"
      />
      @if (tab() === 'folders') {
        <!-- A folder's or a feed's shelf, under Folders (#220): back to them, and its name. -->
        <a class="up" routerLink="/reader/folders"
          ><app-icon name="chevron-left" [size]="18" />Folders</a
        >
        <h2>{{ title() }}</h2>
        @if (feedId(); as id) {
          <!-- One feed's page (2026-11-15): its address, state and actions, then its posts. -->
          <app-reader-feed-head [feedId]="id" />
        }
      } @else {
        <h2 class="visually-hidden">{{ title() }}</h2>
      }
      <p class="tools">
        <label>
          <input type="checkbox" [checked]="showRead()" (change)="showRead.set(!showRead())" />
          Show read
        </label>
        <!-- The list's density (#288), this device's. -->
        <label>
          <input
            type="checkbox"
            [checked]="compact()"
            (change)="density.set(compact() ? 'comfortable' : 'compact')"
          />
          Compact list
        </label>
        <button type="button" class="all" [disabled]="!unreadCount()" (click)="markAll()">
          <app-icon name="check" [size]="16" />Mark all read
        </button>
      </p>
      @if (status()) {
        <p class="status" role="status">
          {{ status() }}
          @if (undoIds()) {
            <button #undoButton type="button" (click)="undo()">Undo</button>
          }
        </p>
      }
      @if (items.loaded() && list().length === 0 && reader.feeds().length) {
        <p class="muted">
          {{ isSaved() ? 'Nothing saved for later.' : 'All caught up.' }}
        </p>
      }
      @if (stuck(); as day) {
        <!-- The day being read, kept at the top while its rows scroll (#288): a picture of
             its heading for the eye, hidden from screen readers, which have the heading
             itself in the list; its Mark these read is the pointer's, out of the tab order. -->
        <div class="current-day" aria-hidden="true">
          <div class="bar">
            <span class="label"
              >{{ day.label }}{{ day.unread.length ? ' · ' + day.unread.length : '' }}</span
            >
            @if (day.unread.length) {
              <button type="button" class="quiet" tabindex="-1" (click)="markDay(day.unread)">
                Mark these read
              </button>
            }
          </div>
        </div>
      }
      <ul aria-label="Articles" [class.compact]="compact()">
        @for (day of days(); track day.key + ':' + day.start) {
          @for (item of day.items; track item.id; let n = $index) {
            <!-- A row (#162), and a day's first carries the day's heading (#288) above it,
                 so the list's items are its articles alone. -->
            <li>
              @if (n === 0) {
                <div class="day" #dayHead [attr.data-day]="day.start">
                  <!-- Named "Today, 2 unread", shown "Today · 2". -->
                  <h3 [id]="'day-' + day.start">
                    <span aria-hidden="true">{{
                      day.label + (day.unread.length ? ' · ' + day.unread.length : '')
                    }}</span
                    ><span class="visually-hidden">{{
                      day.label + (day.unread.length ? ', ' + day.unread.length + ' unread' : '')
                    }}</span>
                  </h3>
                  @if (day.unread.length) {
                    <button
                      type="button"
                      class="quiet"
                      [attr.aria-describedby]="'day-' + day.start"
                      (click)="markDay(day.unread)"
                    >
                      Mark these read
                    </button>
                  }
                </div>
              }
              <div
                class="row"
                #row
                appSwipe
                [attr.data-id]="item.id"
                [class.read]="item.read"
                [class.cursor]="day.start + n === cursor()"
                (left)="items.setRead(item.id, true)"
                (right)="items.setSaved(item.id, !item.saved)"
              >
                <a
                  class="open"
                  draggable="false"
                  [routerLink]="['/reader/a', item.id]"
                  [queryParams]="{ in: param() }"
                  [attr.aria-current]="day.start + n === cursor() ? 'true' : null"
                >
                  @if (!feedId()) {
                    <app-source-mark
                      [class.small]="compact()"
                      [feedId]="item.feedId"
                      [title]="source(item)"
                    />
                  }
                  <span class="text">
                    <span class="title">{{ item.title }}</span>
                    <span class="meta">
                      {{ source(item) }} · {{ items.age(item.published) }}
                      @if (item.enclosure) {
                        <span class="episode"
                          ><span role="img" aria-label="episode">▶</span>
                          @if (item.enclosure.seconds !== undefined) {
                            {{ items.duration(item.enclosure.seconds) }}
                          }
                          @if (downloads.has(item.id)) {
                            · downloaded
                          }
                        </span>
                      }
                      @if (item.saved) {
                        <span class="saved" role="img" aria-label="saved">★</span>
                      }
                      @if (item.noteId) {
                        <span class="filed" role="img" aria-label="in the garden">🌱</span>
                      }
                      @if (isSaved()) {
                        @for (tag of item.tags ?? []; track tag) {
                          <span class="tag">{{ tag }}</span>
                        }
                      }
                    </span>
                    @if (item.summary && !compact()) {
                      <span class="summary">{{ item.summary }}</span>
                    }
                  </span>
                </a>
                <span class="acts">
                  <button
                    type="button"
                    [attr.aria-label]="(item.read ? 'Mark unread: ' : 'Mark read: ') + item.title"
                    (click)="items.setRead(item.id, !item.read)"
                  >
                    {{ item.read ? 'Unread' : 'Read' }}
                  </button>
                  <button
                    type="button"
                    [attr.aria-label]="(item.saved ? 'Unsave: ' : 'Save: ') + item.title"
                    (click)="items.setSaved(item.id, !item.saved)"
                  >
                    {{ item.saved ? 'Unsave' : 'Save' }}
                  </button>
                </span>
              </div>
            </li>
          }
        }
      </ul>
    </main>
  `,
  styles: `
    .up {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 44px;
      margin-top: var(--space-2);
      color: var(--quiet);
      text-decoration: none;
    }
    h2 {
      margin: 0;
      font-size: 18px;
    }
    .tools {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;
    }
    .tools label {
      margin: 0;
    }
    /* Mark all read keeps its word, beside a check, at the row's right (#221). */
    .all {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 44px;
      margin-left: auto;
      padding: 0 12px;
      font: inherit;
      font-size: 14px;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-pill);
      cursor: pointer;
    }
    .all:disabled {
      color: var(--quiet);
      cursor: default;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0 0 56px;
    }
    li {
      border-bottom: 1px solid var(--rule);
    }
    /* The row is what swipes, is observed (#172) and takes the cursor. */
    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: var(--space-2);
      align-items: center;
      background: var(--surface);
      touch-action: pan-y;
    }
    .row.swiping {
      transition: none;
    }
    .row.settling {
      transition: transform 180ms ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      .row.settling {
        transition: none;
      }
    }
    .row.cursor {
      box-shadow: inset 3px 0 0 var(--accent);
    }
    /* A row the keyboard moves to is not left under the day's bar. */
    .row {
      scroll-margin-top: 48px;
    }
    /*
     * A day's heading (#288), above its first row, with Mark these read
     * at its right; and the bar that keeps the day being read at the top.
     * The bar is sticky with no height of its own, so showing it moves no
     * row; it covers the top 40 px, as the heading it stands for would.
     */
    .day,
    .current-day .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      box-sizing: border-box;
      min-height: 40px;
      padding: 0 4px;
      background: var(--bg);
      border-bottom: 1px solid var(--rule);
      font-size: 14px;
      font-weight: 600;
    }
    .day h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--ink);
    }
    .day button,
    .current-day button {
      font-size: 14px;
      font-weight: 400;
    }
    .current-day {
      position: sticky;
      top: 0;
      z-index: 1;
      height: 0;
    }
    .current-day .bar {
      position: absolute;
      inset: 0 0 auto;
    }
    .open {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 4px;
      color: var(--ink);
      text-decoration: none;
      min-width: 0;
    }
    .open app-source-mark {
      margin-top: 2px;
    }
    .text {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .title {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    /*
     * Compact (#288): the title on up to two lines and one line of source
     * and time, no summary; about 64 px a row.
     */
    ul.compact .open {
      align-items: center;
      padding: 7px 4px;
    }
    ul.compact .open app-source-mark {
      margin-top: 0;
    }
    ul.compact .title {
      font-size: 15px;
      line-height: 20px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    ul.compact .meta {
      font-size: 13px;
      line-height: 18px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row.read .title {
      font-weight: 400;
      color: var(--quiet);
    }
    .meta,
    .muted,
    .status {
      color: var(--quiet);
      font-size: 14px;
    }
    /* A Feedly board the article was on (#176), on the Saved shelf. */
    .tag {
      display: inline-block;
      margin-left: 4px;
      padding: 0 6px;
      border: 1px solid var(--rule);
      border-radius: 999px;
      font-size: 12px;
      line-height: 18px;
    }
    /*
     * The status line is a bar fixed at the foot of the screen, so Undo
     * shows wherever the list is scrolled, and showing it moves no row
     * (review on #182); the list leaves room for it at its end. It sits
     * on the mini-player while that shows (#179).
     */
    .status {
      position: fixed;
      inset: auto 0 var(--mini-player-height, 0px);
      /* Over a day's heading (#288) passing behind it. */
      z-index: 2;
      box-sizing: border-box;
      max-width: 640px;
      margin: 0 auto;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;
      padding: var(--space-2) var(--space-3) calc(var(--space-2) + env(safe-area-inset-bottom));
      background: var(--surface);
      border-top: 1px solid var(--rule);
    }
    .summary {
      font-size: 14px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      overflow-wrap: anywhere;
    }
    .acts {
      display: grid;
      gap: 4px;
      padding-right: 4px;
    }
    .acts button {
      min-height: 32px;
    }
    @media (pointer: coarse) {
      .acts {
        display: none;
      }
    }
  `,
})
export class ReaderList {
  protected readonly items = inject(ItemsService);
  protected readonly downloads = inject(DownloadsService);
  protected readonly reader = inject(ReaderService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly now = inject(NOW);
  private readonly tz = inject(TIME_ZONE);
  protected readonly density = inject(ReaderDensity);
  protected readonly compact = computed(() => this.density.value() === 'compact');
  private readonly undoButton = viewChild<ElementRef<HTMLButtonElement>>('undoButton');
  private readonly shelf = toSignal(inject(ActivatedRoute).paramMap.pipe(map(shelfOf)), {
    initialValue: { kind: 'folder', name: ALL } as Shelf2,
  });
  protected readonly showRead = signal(false);
  protected readonly status = signal('');
  protected readonly cursor = signal(-1);

  protected readonly isSaved = computed(
    () => this.shelf().kind === 'folder' && (this.shelf() as { name: string }).name === SAVED,
  );
  protected readonly param = computed(() => shelfParam(this.shelf()));
  /** Rows marked read on scroll, kept in the list until it is left or the shelf changes (#172). */
  private readonly held = signal<ReadonlySet<string>>(new Set());
  /** The last batch marked on scroll, while Undo is offered. */
  protected readonly undoIds = signal<string[] | undefined>(undefined);
  protected readonly list = computed(() => {
    const shown = this.items.inShelf(this.shelf(), this.showRead());
    const held = this.held();
    if (!held.size) return shown;
    const ids = new Set(shown.map((i) => i.id));
    return this.items.inShelf(this.shelf(), true).filter((i) => ids.has(i.id) || held.has(i.id));
  });
  protected readonly unreadCount = computed(() => this.list().filter((i) => !i.read).length);
  /**
   * The list by day (#288), in the gardener's time: the rows in the
   * list's own order, so the cursor's index still names its row. "Now"
   * is read when the list changes, so a list left open past midnight
   * keeps yesterday's Today until it does.
   */
  protected readonly days = computed(() => groupByDay(this.list(), this.now(), this.tz));
  /** The folder chips' current one (#288): on All and a folder's list, not Saved or a feed's. */
  protected readonly chipFolder = computed(() => {
    const shelf = this.shelf();
    return shelf.kind === 'folder' && shelf.name !== SAVED ? shelf.name : undefined;
  });
  protected readonly title = computed(() => shelfTitle(this.shelf(), this.reader.feeds()));
  /** The Reader's tab this shelf is (#220): All or Saved, else under Folders. */
  protected readonly tab = computed<ReaderTab>(() => tabOf(this.shelf()));
  /** The feed, when the list is one feed's: its page's head shows it (2026-11-15). */
  protected readonly feedId = computed(() => {
    const shelf = this.shelf();
    return shelf.kind === 'feed' ? shelf.id : undefined;
  });

  private readonly rows = viewChildren('row', { read: ElementRef<HTMLElement> });
  private readonly dayHeads = viewChildren('dayHead', { read: ElementRef<HTMLElement> });
  /** The day whose heading has gone under the top bar's place, by its start (#288). */
  private readonly stuckAt = signal<number | undefined>(undefined);
  /** The day the top bar shows, while its heading is scrolled away. */
  protected readonly stuck = computed(() => {
    const at = this.stuckAt();
    return at === undefined ? undefined : this.days().find((d) => d.start === at);
  });
  private barFrame = 0;
  private observer?: IntersectionObserver;
  private readonly observed = new Set<HTMLElement>();
  /**
   * Rows the observer has reported once. Its first look at a row only
   * says where it is, so a row found above the top then (a reload, or a
   * row the list put back while scrolled down) has not been passed
   * (#172).
   */
  private readonly looked = new WeakSet<Element>();
  /** Rows above the top, waiting out the moment, by id. */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** Rows above the top long enough, marked once the page is still. */
  private readonly passed = new Set<string>();
  /** Rows that went wholly above the top and are still there, by id, whether or not their moment has started. */
  private readonly above = new Set<string>();
  /**
   * Whether the gardener has moved the page since the list showed: a
   * scroll after a wheel, a touch, a key or a press (review on #182).
   * Until then nothing counts as passed, so rows a reload or Back put
   * above the top, or a scroll the browser restores, mark nothing.
   */
  private armed = false;
  private touched = false;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private undoTimer?: ReturnType<typeof setTimeout>;
  /** The shelf already noted as seen, so it is noted once (#173). */
  private seenShelf?: Shelf2;

  constructor() {
    // A folder's list opened: what is in it stops being new in Right
    // Now (#173). Once everything is read, so the folder is known and
    // the settings doc is written whole; once per shelf.
    effect(() => {
      const shelf = this.shelf();
      if (shelf.kind !== 'folder' || shelf.name === ALL || shelf.name === SAVED) return;
      if (!this.items.loaded() || !this.reader.loaded() || !this.reader.settingsLoaded()) return;
      // Only a folder the feeds are in: a name no feed is filed under
      // is never a line in Right Now, so it is not noted.
      if (!this.reader.folderNames().includes(shelf.name)) return;
      if (this.seenShelf === shelf) return;
      this.seenShelf = shelf;
      untracked(() => this.items.markSeen(shelf.name));
    });
    // Another shelf starts afresh: no hold, nothing waiting, no Undo.
    // And a list on screen ends the run through its articles: the next
    // one opened counts from the unread, not from all read before it.
    effect(() => {
      this.shelf();
      untracked(() => {
        this.forget();
        this.items.forgetVisits();
      });
    });
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver((entries) => this.seen(entries));
      afterRenderEffect(() => this.observe(this.rows()));
    }
    const onInput = () => (this.touched = true);
    // The top bar follows the headings: after each render, and a frame
    // after a scroll.
    afterRenderEffect(() => {
      this.dayHeads();
      this.days();
      untracked(() => this.placeBar());
    });
    const onScroll = () => {
      if (this.touched && !this.armed) this.arm();
      this.settle();
      if (!this.barFrame) {
        this.barFrame = requestAnimationFrame(() => {
          this.barFrame = 0;
          this.placeBar();
        });
      }
    };
    for (const type of INPUTS) window.addEventListener(type, onInput, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    inject(DestroyRef).onDestroy(() => {
      for (const type of INPUTS) window.removeEventListener(type, onInput);
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(this.barFrame);
      this.observer?.disconnect();
      this.forget();
    });
  }

  protected source(item: ItemRecord): string {
    return this.reader.feeds().find((f) => f.id === item.feedId)?.title ?? 'Unknown feed';
  }

  /**
   * Mark all read: every unread article at hand on the shelf, in one
   * batch, with Undo for it as for the scroll's batch (#288; until then
   * it had none).
   */
  protected markAll(): void {
    this.markMany(
      this.items
        .inShelf(this.shelf(), false)
        .filter((i) => !i.read)
        .map((i) => i.id),
    );
  }

  /**
   * A day's Mark these read (#288): only that day's unread rows as
   * listed, through the same batch and the same Undo as Mark all read.
   * The button goes with its day's last unread row, so the focus goes
   * to Undo.
   */
  protected markDay(ids: readonly string[]): void {
    this.markMany(ids.filter((id) => this.items.find(id)?.read === false));
    afterNextRender(() => this.undoButton()?.nativeElement.focus(), { injector: this.injector });
  }

  private markMany(ids: string[]): void {
    const n = this.items.setReadMany(ids, true);
    this.status.set(n ? `${n} marked read.` : 'Nothing to mark.');
    this.offerUndo(n ? ids : undefined);
  }

  @HostListener('document:keydown', ['$event'])
  protected keys(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    // The feed's More sheet (2026-11-15) keeps its own keys, and Enter
    // on a button presses it rather than opening a row.
    if (target?.closest?.('dialog')) return;
    if (event.key === 'Enter' && target?.closest('a, button')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const list = this.list();
    const at = this.cursor();
    const current = list[at];
    switch (event.key) {
      case 'j':
        this.moveCursor(Math.min(at + 1, list.length - 1));
        break;
      case 'k':
        this.moveCursor(Math.max(at - 1, 0));
        break;
      case 'm':
        if (current) this.items.setRead(current.id, !current.read);
        break;
      case 's':
        if (current) this.items.setSaved(current.id, !current.saved);
        break;
      case 'Enter':
      case 'o':
        if (current) {
          void this.router.navigate(['/reader/a', current.id], {
            queryParams: { in: this.param() },
          });
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /**
   * Which day the top bar shows (#288): the last whose heading is above
   * the bar's bottom edge, so the bar takes over from a heading as it
   * reaches the top; none while the first is still below it. A heading
   * with no box (not laid out) counts as below.
   */
  private placeBar(): void {
    let at: number | undefined;
    for (const ref of this.dayHeads()) {
      const box = ref.nativeElement.getBoundingClientRect();
      if (!box.height || box.top >= BAR_PX) break;
      at = Number(ref.nativeElement.dataset['day']);
    }
    this.stuckAt.set(at);
  }

  /** Undoes the last batch marked on scroll: unread again, and no longer held. */
  protected undo(): void {
    const ids = this.undoIds();
    if (!ids) return;
    this.offerUndo(undefined);
    // Nothing more counts until the gardener moves the page again, and
    // the rows undone are passed only once they come back and go again.
    this.armed = this.touched = false;
    for (const id of ids) this.drop(id);
    const n = this.items.setReadMany(ids, false);
    this.held.update((h) => {
      const next = new Set(h);
      for (const id of ids) next.delete(id);
      return next;
    });
    this.status.set(`${n} unread again.`);
  }

  /** Follows the rows on the page, and lets go of the ones that left it. */
  private observe(rows: readonly ElementRef<HTMLElement>[]): void {
    const now = new Set(rows.map((r) => r.nativeElement));
    for (const el of this.observed) {
      if (now.has(el)) continue;
      this.observer?.unobserve(el);
      this.observed.delete(el);
      const id = el.dataset['id'];
      if (id) this.drop(id);
    }
    for (const el of now) {
      if (this.observed.has(el)) continue;
      this.observer?.observe(el);
      this.observed.add(el);
    }
  }

  /**
   * A row that goes wholly above the top starts its moment, once the
   * page has been moved; one back in view, or below, is dropped. The
   * observer's first look at a row is no move past it (#172).
   */
  private seen(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset['id'];
      if (!id) continue;
      const first = !this.looked.has(entry.target);
      this.looked.add(entry.target);
      const above =
        !entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0);
      if (!above) {
        this.drop(id);
        continue;
      }
      if (first) continue;
      this.above.add(id);
      if (this.armed) this.start(id);
    }
  }

  /** The first move of the page: rows that went above the top before it start their moment. */
  private arm(): void {
    this.armed = true;
    for (const id of this.above) this.start(id);
  }

  /** Starts a row's moment above the top. Only unread rows, and only with the switch on. */
  private start(id: string): void {
    if (this.pending.has(id) || this.passed.has(id)) return;
    if (!this.reader.readOnScroll() || this.items.find(id)?.read !== false) return;
    this.pending.set(
      id,
      setTimeout(() => {
        this.pending.delete(id);
        this.passed.add(id);
        this.settle();
      }, PASSED_MS),
    );
  }

  private drop(id: string): void {
    this.above.delete(id);
    clearTimeout(this.pending.get(id));
    this.pending.delete(id);
    this.passed.delete(id);
  }

  /** Marks the passed rows once the page has been still a moment. */
  private settle(): void {
    if (!this.pending.size && !this.passed.size) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.markPassed(), SETTLE_MS);
  }

  private markPassed(): void {
    const ids = [...this.passed].filter((id) => this.items.find(id)?.read === false);
    this.passed.clear();
    if (!ids.length || !this.reader.readOnScroll()) return;
    const n = this.items.setReadMany(ids, true);
    if (!n) return;
    this.held.update((h) => new Set([...h, ...ids]));
    this.status.set(`Marked ${n} read.`);
    this.offerUndo(ids);
  }

  /** Offers Undo for a batch for a few seconds, or takes the offer back. */
  private offerUndo(ids: string[] | undefined): void {
    clearTimeout(this.undoTimer);
    this.undoIds.set(ids);
    if (ids) this.undoTimer = setTimeout(() => this.undoIds.set(undefined), UNDO_MS);
  }

  /** Drops the hold, whatever is waiting and the Undo offer. */
  private forget(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.passed.clear();
    this.above.clear();
    this.armed = false;
    this.touched = false;
    clearTimeout(this.settleTimer);
    if (this.undoIds()) this.status.set('');
    this.offerUndo(undefined);
    this.held.set(new Set());
  }

  private moveCursor(to: number): void {
    this.cursor.set(to);
    // The rows alone: not a search's hits.
    document
      .querySelectorAll('app-reader-list [data-id]')
      [to]?.scrollIntoView({ block: 'nearest' });
  }
}
