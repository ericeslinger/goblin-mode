import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  afterRenderEffect,
  booleanAttribute,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
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
import { ReadAct, SaveAct } from './item-acts';
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
/** What the gardener does to move the page, as against the browser restoring it. */
const INPUTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
const NO_IDS: ReadonlySet<string> = new Set();

export function shelfFromParam(value: string | null): Shelf2 {
  if (value?.startsWith('s:')) return { kind: 'feed', id: value.slice(2) };
  if (value?.startsWith('f:')) return { kind: 'folder', name: value.slice(2) };
  return { kind: 'folder', name: ALL };
}

/** Whether two shelves are the same list. */
export function sameShelf(a: Shelf2, b: Shelf2): boolean {
  return shelfParam(a) === shelfParam(b);
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
 * With Mark articles read as I scroll past them on (Settings, Modules,
 * under Reader; #172), an unread row that stays above the top for a moment counts
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
 * The articles are a group named Articles holding a section a day
 * (2026-11-16): the day's heading row, sticky within its section, and
 * the day's list, named by its heading, of rows. Days are kept by
 * their key and rows by id, so a change above a day leaves its rows'
 * nodes, their swipe and their place for the observer as they were.
 *
 * In the Reader's panes (#289, 2026-11-16; two since 2026-11-22) it is
 * the list pane: the panes draw the header, the shelf is theirs
 * (`shelf`), the list scrolls in its own box, which is what the
 * observer of #172 watches and the status bar sits at the foot of, and
 * the article open beside it (`current`) is its current row, scrolled
 * into view once, kept in the list once read as the ones read on the
 * way are. Its keys are the article's while one is open (`ownKeys`).
 *
 * A row's Keep unread (or Mark read) and Save for later are the
 * article toolbar's own icons, small and side by side at its end
 * (`ReadAct`, `SaveAct`; Eric, 2026-11-22, in place of the words
 * Unread and Save); on touch they are hidden, as the words were, and
 * the swipe does both.
 */
@Component({
  selector: 'app-reader-list',
  imports: [
    Icon,
    NgTemplateOutlet,
    ReadAct,
    ReaderBar,
    ReaderFeedHead,
    RouterLink,
    SaveAct,
    SourceMarkView,
    Swipe,
  ],
  host: { '[class.in-panes]': 'pane()' },
  template: `
    @if (pane()) {
      <div class="pane-body" #scroller (scroll)="scrolled()">
        <ng-container [ngTemplateOutlet]="body" />
      </div>
    } @else {
      <main class="page">
        <app-reader-bar
          [active]="tab()"
          [current]="tab() === 'folders' ? 'true' : 'page'"
          [folder]="chipFolder()"
        />
        <ng-container [ngTemplateOutlet]="body" />
      </main>
    }
    <ng-template #body>
      @if (tab() === 'folders') {
        <!-- A folder's or a feed's shelf, under Folders (#220): back to them, and its name. -->
        <a class="up" routerLink="/reader/folders"
          ><app-icon name="chevron-left" [size]="18" />Folders</a
        >
        <h2 #heading tabindex="-1">{{ title() }}</h2>
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
      <!-- The articles by day (#288): a section a day, its heading row sticking while its
           day scrolls, and the day's own list of rows. Focus comes here when Undo goes. -->
      <div
        #articles
        class="days"
        role="group"
        aria-label="Articles"
        tabindex="-1"
        [class.compact]="compact()"
      >
        @for (day of days(); track day.key) {
          <section class="day">
            <div class="day-head">
              <!-- Named "Today, 2 unread", shown "Today · 2". -->
              <h3 [id]="'day-' + day.key">
                <span aria-hidden="true">{{
                  day.label + (day.unread.length ? ' · ' + day.unread.length : '')
                }}</span
                ><span class="visually-hidden">{{
                  day.label + (day.unread.length ? ', ' + day.unread.length + ' unread' : '')
                }}</span>
              </h3>
              @if (day.unread.length && pane()) {
                <!-- In the panes a tick, as Mark all read's, its words its name and tooltip
                     (Eric, 2026-11-22: "most buttons should have icons with tooltips"). -->
                <button
                  type="button"
                  class="day-mark"
                  aria-label="Mark these read"
                  title="Mark these read: this day's unread"
                  [attr.aria-describedby]="'day-' + day.key"
                  (click)="markDay(day.unread)"
                >
                  <app-icon name="check" [size]="18" />
                </button>
              } @else if (day.unread.length) {
                <button
                  type="button"
                  class="quiet"
                  [attr.aria-describedby]="'day-' + day.key"
                  (click)="markDay(day.unread)"
                >
                  Mark these read
                </button>
              }
            </div>
            <ul [attr.aria-labelledby]="'day-' + day.key">
              @for (item of day.items; track item.id; let n = $index) {
                <li
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
                  <!-- The article toolbar's own Keep unread and Save for later, small, side by
                       side (Eric, 2026-11-22); each named with the row's title. -->
                  <span class="acts">
                    <button appReadAct small [item]="item" [about]="item.title"></button>
                    <button appSaveAct small [item]="item" [about]="item.title"></button>
                  </span>
                </li>
              }
            </ul>
          </section>
        }
      </div>
    </ng-template>
  `,
  styles: `
    /* The list pane (#289): its own scroll box, the status at its foot. */
    :host(.in-panes) {
      display: block;
      position: relative;
      height: 100%;
    }
    .pane-body {
      box-sizing: border-box;
      height: 100%;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 0 var(--space-3);
    }
    :host(.in-panes) .status {
      position: absolute;
      inset: auto 0 0 0;
      max-width: none;
    }
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
    /* Room at the end for the status bar. */
    .days {
      padding-bottom: 56px;
    }
    .days:focus {
      outline: none;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    /* The row (#162): what swipes, what the observer follows (#172) and what the cursor names. */
    li {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: var(--space-2);
      align-items: center;
      border-bottom: 1px solid var(--rule);
      background: var(--surface);
      touch-action: pan-y;
      /* A row the keyboard moves to, or a place restored, clears its day's heading. */
      scroll-margin-top: 48px;
    }
    li.swiping {
      transition: none;
    }
    li.settling {
      transition: transform 180ms ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      li.settling {
        transition: none;
      }
    }
    li.cursor {
      box-shadow: inset 3px 0 0 var(--accent);
    }
    /*
     * A day's heading row (#288), Mark these read at its right. It sticks
     * to the top while its day's rows scroll, within its section, so the
     * next day's pushes it off.
     */
    .day-head {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      box-sizing: border-box;
      min-height: 40px;
      padding: 0 4px;
      background: var(--bg);
      border-bottom: 1px solid var(--rule);
    }
    .day-head h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--ink);
    }
    .day-head button {
      font-size: 14px;
    }
    .day-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-control);
      background: transparent;
    }
    .day-mark:hover {
      background: var(--chip-bg);
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
    .days.compact .open {
      align-items: center;
      padding: 7px 4px;
    }
    .days.compact .open app-source-mark {
      margin-top: 0;
    }
    .days.compact .title {
      font-size: 15px;
      line-height: 20px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .days.compact .meta {
      font-size: 13px;
      line-height: 18px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    li.read .title {
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
      /* From the desktop rail's edge (#289), so it centres under the page. */
      inset: auto 0 var(--mini-player-height, 0px) var(--rail-width, 0px);
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
    /* A row's two icons, side by side at its end (2026-11-22). */
    .acts {
      display: flex;
      gap: 2px;
      padding-right: 2px;
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
  /** The list pane of the Reader's panes (#289). */
  readonly pane = input(false, { transform: booleanAttribute });
  /** The panes' shelf, which their route says; otherwise the list's own route's. */
  readonly shelfIn = input<Shelf2 | undefined>(undefined, { alias: 'shelf' });
  /** The article open beside the list, in the panes: its current row. */
  readonly current = input<string | undefined>(undefined);
  /** Whether the list's keys are its own: not while an article beside it has them. */
  readonly ownKeys = input(true);
  /**
   * In the panes, whether the list is one the gardener just chose, from
   * the Folders the list pane showed (2026-11-22): the link pressed has
   * gone with them, so the list takes the focus, its heading on a
   * folder's or a feed's list. Not a list a reload drew.
   */
  readonly arriving = input(false);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly routeShelf = toSignal(inject(ActivatedRoute).paramMap.pipe(map(shelfOf)), {
    initialValue: { kind: 'folder', name: ALL } as Shelf2,
  });
  private readonly shelf = computed(() => this.shelfIn() ?? this.routeShelf(), {
    equal: sameShelf,
  });
  protected readonly showRead = signal(false);
  protected readonly status = signal('');
  /**
   * The keyboard's row, by its index as drawn; in the panes the
   * article open beside the list, wherever its row has moved to.
   */
  protected readonly cursor = linkedSignal<{ id?: string; drawn: ItemRecord[] }, number>({
    source: () => ({ id: this.current(), drawn: this.drawn() }),
    computation: ({ id, drawn }, previous) => {
      const at = id ? drawn.findIndex((i) => i.id === id) : -1;
      return at >= 0 ? at : (previous?.value ?? -1);
    },
  });

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
    const kept = this.kept();
    if (!held.size && !kept.size) return shown;
    const ids = new Set(shown.map((i) => i.id));
    return this.items
      .inShelf(this.shelf(), true)
      .filter((i) => ids.has(i.id) || held.has(i.id) || kept.has(i.id));
  });
  /**
   * In the panes, the articles opened on the way through the shelf
   * and the one open now stay in the list once read (#289), as the
   * article's next and previous count them, so its row stays current
   * and nothing moves under the gardener.
   */
  private readonly kept = computed<ReadonlySet<string>>(() => {
    if (!this.pane()) return NO_IDS;
    const visited = this.items.visitedIn(this.shelf());
    const id = this.current();
    return id ? new Set([...visited, id]) : visited;
  });
  protected readonly unreadCount = computed(() => this.list().filter((i) => !i.read).length);
  /**
   * The list by day (#288), in the gardener's time: the rows in the
   * list's own order, so the cursor's index still names its row. "Now"
   * is read when the list changes, so a list left open past midnight
   * keeps yesterday's Today until it does.
   */
  protected readonly days = computed(() => groupByDay(this.list(), this.now(), this.tz));
  /**
   * The rows in the order they are drawn, day by day: what the cursor's
   * index counts, and in the panes what the article's next and previous
   * go along (#289).
   */
  readonly drawn = computed(() => this.days().flatMap((d) => d.items));
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
  private readonly articlesBox = viewChild<ElementRef<HTMLElement>>('articles');
  /** The list pane's own scroll box (#289), the observer's root there. */
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  /** The current row last scrolled into view, so it is scrolled to once. */
  private revealed?: string;
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
    // In the panes the list is on screen beside the run (#289): one
    // they open with an article (a reload, a wider window) keeps it.
    let first = true;
    effect(() => {
      this.shelf();
      untracked(() => {
        const keep = first && this.pane() && !!this.current();
        first = false;
        this.forget();
        if (!keep) this.items.forgetVisits();
      });
    });
    // The run ends in the panes as it does on a phone, when the list
    // is the screen again (2026-11-11): there, that is the article
    // pane closing (Escape, its back link, a folder chosen). The rows
    // read on the way then leave the list, and the next article
    // opened counts from the unread (review on #305, 2026-11-16).
    let reading = false;
    effect(() => {
      const alone = this.ownKeys();
      if (!this.pane()) return;
      untracked(() => {
        if (alone && reading) this.items.forgetVisits();
        reading = !alone;
      });
    });
    // In the panes the current row is scrolled into view first, then
    // the rows are followed, so the observer's first look is from
    // where that left them, and rows it put above the top are not
    // passed (#172).
    afterRenderEffect(() => {
      const rows = this.rows();
      if (this.pane()) this.reveal(this.current(), rows);
      if (typeof IntersectionObserver !== 'undefined') this.observe(rows);
    });
    // Chosen in the panes with the focus gone with the link pressed:
    // the focus to the list's heading, or its articles on All or Saved.
    afterNextRender(() => {
      if (!this.pane() || !this.arriving()) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      (this.heading() ?? this.articlesBox())?.nativeElement.focus({ preventScroll: true });
    });
    const onInput = () => (this.touched = true);
    const onScroll = () => this.scrolled();
    for (const type of INPUTS) window.addEventListener(type, onInput, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    inject(DestroyRef).onDestroy(() => {
      for (const type of INPUTS) window.removeEventListener(type, onInput);
      window.removeEventListener('scroll', onScroll);
      this.observer?.disconnect();
      this.forget();
    });
  }

  /** The page moved: the window's scroll, or the list pane's (#289). */
  protected scrolled(): void {
    if (this.touched && !this.armed) this.arm();
    this.settle();
  }

  /** The article open beside the list, its row scrolled into view once it is drawn (#289). */
  private reveal(id: string | undefined, rows: readonly ElementRef<HTMLElement>[]): void {
    if (!id || id === this.revealed) return;
    const row = rows.find((r) => r.nativeElement.dataset['id'] === id)?.nativeElement;
    if (!row) return;
    this.revealed = id;
    row.scrollIntoView?.({ block: 'nearest' });
    this.relook();
  }

  /**
   * The rows looked at afresh, after the list scrolled itself: a row
   * that scroll put above the top was not passed by the gardener, so
   * the observer's next report on each is a first look again (#172).
   */
  private relook(): void {
    if (!this.observer) return;
    for (const el of this.observed) {
      this.observer.unobserve(el);
      this.looked.delete(el);
      const id = el.dataset['id'];
      if (id) this.drop(id);
      this.observer.observe(el);
    }
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
   */
  protected markDay(ids: readonly string[]): void {
    this.markMany(ids.filter((id) => this.items.find(id)?.read === false));
  }

  /**
   * Marks a batch read and offers Undo. The button pressed may go with
   * what it marked (a day's, or Mark all read disabled), so the focus
   * goes to Undo.
   */
  private markMany(ids: string[]): void {
    const n = this.items.setReadMany(ids, true);
    if (!n) {
      // A showing Undo for an earlier batch stays, its words and its
      // seconds as they were (review on #297).
      if (!this.undoIds()) this.status.set('Nothing to mark.');
      return;
    }
    this.offerUndo(ids, (all) => `${all} marked read.`);
    afterNextRender(() => this.undoButton()?.nativeElement.focus(), { injector: this.injector });
  }

  @HostListener('document:keydown', ['$event'])
  protected keys(event: KeyboardEvent): void {
    // In the panes, an article beside the list has the keys (#289).
    if (!this.ownKeys()) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    // The feed's More sheet (2026-11-15) keeps its own keys, and Enter
    // on a button presses it rather than opening a row.
    if (target?.closest?.('dialog')) return;
    if (event.key === 'Enter' && target?.closest('a, button')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const list = this.drawn();
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
   * Undoes everything marked since the offer appeared (#172, #288): the
   * scroll's batches, a day's and Mark all read alike, unread again and
   * no longer held. Undo goes with it, so the focus goes to the list.
   */
  protected undo(): void {
    const ids = this.undoIds();
    if (!ids) return;
    this.offerUndo(undefined);
    this.focusList();
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
    // Made once the list is drawn: in the panes its root is the list's
    // own scroll box, which a row above the top has left (#289).
    this.observer ??= new IntersectionObserver((entries) => this.seen(entries), {
      root: this.pane() ? (this.scroller()?.nativeElement ?? null) : null,
    });
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
    this.offerUndo(ids, (all) => `Marked ${all} read.`);
  }

  /**
   * Offers Undo for a few seconds, or takes the offer back. A batch
   * marked while the offer shows joins it (#288): Undo then restores
   * everything since the offer appeared, the status says how many, and
   * the few seconds start again.
   */
  private offerUndo(ids: string[] | undefined, say?: (all: number) => string): void {
    clearTimeout(this.undoTimer);
    if (!ids) {
      this.undoIds.set(undefined);
      return;
    }
    const all = [...new Set([...(this.undoIds() ?? []), ...ids])];
    this.undoIds.set(all);
    if (say) this.status.set(say(all.length));
    this.undoTimer = setTimeout(() => this.lapse(), UNDO_MS);
  }

  /** The offer lapses; if Undo had the focus, the list takes it rather than the page. */
  private lapse(): void {
    const focused = this.undoButton()?.nativeElement === document.activeElement;
    this.undoIds.set(undefined);
    if (focused) this.focusList();
  }

  /** Focus to the articles, once the page has drawn what took it away. */
  private focusList(): void {
    afterNextRender(() => this.articlesBox()?.nativeElement.focus({ preventScroll: true }), {
      injector: this.injector,
    });
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
