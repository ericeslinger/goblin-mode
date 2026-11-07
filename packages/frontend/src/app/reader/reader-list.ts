import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { ALL, type ItemRecord, ItemsService, PODCASTS, SAVED, type Shelf2 } from './items.service';
import { type FeedRecord, ReaderService } from './reader.service';
import { Swipe } from './swipe';

/** The shelf a list shows, from its route: `/reader/f/<folder>` or `/reader/s/<feedId>`. */
export function shelfOf(params: { get(name: string): string | null }): Shelf2 {
  const feed = params.get('feedId');
  return feed ? { kind: 'feed', id: feed } : { kind: 'folder', name: params.get('folder') ?? ALL };
}

/** A shelf as the article's `in` query parameter carries it. */
export function shelfParam(shelf: Shelf2): string {
  return shelf.kind === 'feed' ? `s:${shelf.id}` : `f:${shelf.name}`;
}

/** How long a row stays above the top before it counts as passed (#172). */
export const PASSED_MS = 600;
/** How long the page is still before passed rows are marked. */
export const SETTLE_MS = 300;
/** How long Undo is offered for the last batch. */
export const UNDO_MS = 6000;
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

/** A shelf's name as its list's heading shows it. */
export function shelfTitle(shelf: Shelf2, feeds: readonly FeedRecord[]): string {
  if (shelf.kind === 'feed') return feeds.find((f) => f.id === shelf.id)?.title ?? 'Feed';
  if (shelf.name === PODCASTS) return 'Podcasts';
  return shelf.name === ALL ? 'All' : shelf.name === SAVED ? 'Saved' : shelf.name;
}

/**
 * The compact list (#162): a folder's or a feed's articles, newest
 * first, unread unless Show read; an episode's row says so and how
 * long it is (#178). Swipe a row left to mark it read,
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
 */
@Component({
  selector: 'app-reader-list',
  imports: [RouterLink, Swipe],
  template: `
    <main class="page">
      <a routerLink="/reader">Back</a>
      <h1>{{ title() }}</h1>
      <p class="tools">
        <label>
          <input type="checkbox" [checked]="showRead()" (change)="showRead.set(!showRead())" />
          Show read
        </label>
        <button type="button" [disabled]="!unreadCount()" (click)="markAll()">Mark all read</button>
        @if (feedLink()) {
          <a [href]="feedLink()" target="_blank" rel="noopener noreferrer">The site</a>
        }
      </p>
      @if (status()) {
        <p class="status" role="status">
          {{ status() }}
          @if (undoIds()) {
            <button type="button" (click)="undo()">Undo</button>
          }
        </p>
      }
      @if (items.loaded() && list().length === 0) {
        <p class="muted">
          {{ isSaved() ? 'Nothing saved for later.' : 'All caught up.' }}
        </p>
      }
      <ul aria-label="Articles">
        @for (item of list(); track item.id; let i = $index) {
          <li
            #row
            appSwipe
            [attr.data-id]="item.id"
            [class.read]="item.read"
            [class.cursor]="i === cursor()"
            (left)="items.setRead(item.id, true)"
            (right)="items.setSaved(item.id, !item.saved)"
          >
            <a
              class="open"
              draggable="false"
              [routerLink]="['/reader/a', item.id]"
              [queryParams]="{ in: param() }"
              [attr.aria-current]="i === cursor() ? 'true' : null"
            >
              <span class="title">{{ item.title }}</span>
              <span class="meta">
                {{ source(item) }} · {{ items.age(item.published) }}
                @if (item.enclosure) {
                  <span class="episode"
                    ><span role="img" aria-label="episode">▶</span>
                    @if (item.enclosure.seconds !== undefined) {
                      {{ items.duration(item.enclosure.seconds) }}
                    }
                  </span>
                }
                @if (item.saved) {
                  <span class="saved" role="img" aria-label="saved">★</span>
                }
                @if (item.noteId) {
                  <span class="filed" role="img" aria-label="in the garden">🌱</span>
                }
              </span>
              @if (item.summary) {
                <span class="summary">{{ item.summary }}</span>
              }
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
          </li>
        }
      </ul>
    </main>
  `,
  styles: `
    .tools {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0 0 56px;
    }
    li {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: var(--space-2);
      align-items: center;
      border-bottom: 1px solid var(--rule);
      background: var(--surface);
      touch-action: pan-y;
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
    .open {
      display: grid;
      gap: 2px;
      padding: 10px 4px;
      color: var(--ink);
      text-decoration: none;
      min-width: 0;
    }
    .title {
      font-weight: 600;
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
    /*
     * The status line is a bar fixed at the foot of the screen, so Undo
     * shows wherever the list is scrolled, and showing it moves no row
     * (review on #182); the list leaves room for it at its end. It sits
     * on the mini-player while that shows (#179).
     */
    .status {
      position: fixed;
      inset: auto 0 var(--mini-player-height, 0px);
      z-index: 1;
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
    .status button {
      min-height: 32px;
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
  protected readonly reader = inject(ReaderService);
  private readonly router = inject(Router);
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
  protected readonly title = computed(() => shelfTitle(this.shelf(), this.reader.feeds()));
  /** One feed's site, when the list is that feed's. */
  protected readonly feedLink = computed(() => {
    const shelf = this.shelf();
    if (shelf.kind !== 'feed') return undefined;
    const feed = this.reader.feeds().find((f) => f.id === shelf.id);
    return feed?.site ?? feed?.url;
  });

  private readonly rows = viewChildren('row', { read: ElementRef<HTMLElement> });
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
      // Only a folder the feeds are in: a shelf of the app's own, such
      // as Podcasts, is never a line in Right Now, so it is not noted.
      if (!this.reader.folderNames().includes(shelf.name)) return;
      if (this.seenShelf === shelf) return;
      this.seenShelf = shelf;
      untracked(() => this.items.markSeen(shelf.name));
    });
    // Another shelf starts afresh: no hold, nothing waiting, no Undo.
    effect(() => {
      this.shelf();
      untracked(() => this.forget());
    });
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver((entries) => this.seen(entries));
      afterRenderEffect(() => this.observe(this.rows()));
    }
    const onInput = () => (this.touched = true);
    const onScroll = () => {
      if (this.touched && !this.armed) this.arm();
      this.settle();
    };
    for (const type of INPUTS) window.addEventListener(type, onInput, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    inject(DestroyRef).onDestroy(() => {
      for (const type of INPUTS) window.removeEventListener(type, onInput);
      window.removeEventListener('scroll', onScroll);
      this.observer?.disconnect();
      this.forget();
    });
  }

  protected source(item: ItemRecord): string {
    return this.reader.feeds().find((f) => f.id === item.feedId)?.title ?? 'Unknown feed';
  }

  protected markAll(): void {
    this.offerUndo(undefined);
    const n = this.items.markAllRead(this.shelf());
    this.status.set(n ? `${n} marked read.` : 'Nothing to mark.');
  }

  @HostListener('document:keydown', ['$event'])
  protected keys(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
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
    document.querySelectorAll('app-reader-list li')[to]?.scrollIntoView({ block: 'nearest' });
  }
}
