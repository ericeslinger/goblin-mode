import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  isIsoDate,
  localDate,
  paths,
  planSlots,
  planStartFor,
  checklist,
} from '@mossgoblin/schema';
import { AuthService } from '../auth.service';
import { inLens } from '../browse/lenses';
import { ACTIVITY_API } from '../claude/activity';
import { FIREBASE } from '../firebase';
import { HabitsService } from '../habits/habits.service';
import { GroceryService } from '../kitchen/grocery.service';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW } from '../platform/platform';
import { PlayerService } from '../reader/player.service';
import { ReaderService } from '../reader/reader.service';
import { ItemsService } from '../reader/items.service';
import { FreshCounts, sinceLooked } from '../reminders/fresh-line';
import { RemindersService } from '../reminders/reminders.service';
import { ShareWaiting } from '../share/share-waiting';
import { SignIn } from '../sign-in/sign-in';
import {
  HomeTilesService,
  TILE_IDS,
  arrange,
  moveBy,
  moveTo,
  nearestSlot,
  type Slot,
} from './home-tiles';
import { Icon, type IconName } from './icon';
import { NewNoteButton } from './new-note';
import { PLACES, PlacesService } from './places';

/** Right Now's row names at most this many reminders, of those due today. */
export const HOME_REMINDERS = 2;
/** The box's hint shows until the gardener has this many notes (#288). */
export const HINT_UNTIL_NOTES = 5;
/** How long a tile is held to open Arrange Home (#222), in milliseconds. */
export const HOLD_MS = 400;
/** The grid's columns, for a grip's Up and Down. */
const COLUMNS = 2;
/** How far a held finger may wander before it is a scroll, not a hold. */
const HOLD_SLOP = 10;

interface Tile {
  id: string;
  name: string;
  icon: IconName;
  link: string;
  status: string;
  /** Nothing in it: its line is drawn in the quiet ink (#288). */
  empty: boolean;
}

/** A tile being dragged by its grip: the order it would drop in, and where it is. */
interface Drag {
  id: string;
  order: string[];
  /** Each tile's slot at the start, relative to the list. */
  slots: Slot[];
  /** The dragged tile's offset from its own slot. */
  dx: number;
  dy: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Home (#219, step 1 of #216, design A, Eric 2026-11-09): the box to
 * write in, Right Now's next few, and a tile for each place with a line
 * on how it stands. The box is a link to the capture note at `/`, so
 * writing is the launch screen's own flow, unchanged; nothing here
 * waits on auth or the network before it shows. A module that is off
 * has no tile. Signed out, only sign-in.
 *
 * Arrange Home (#222, step 2): a tile held for HOLD_MS, or the Arrange
 * Home button, turns the grid into a list with a grip on each tile;
 * the grip drags it, or moves it a slot per arrow key. Not on Home
 * lists the tiles taken off. Each change is kept at once.
 */
@Component({
  selector: 'app-home',
  imports: [RouterLink, Icon, NewNoteButton, ShareWaiting, SignIn],
  template: `
    @if (auth.user() === null) {
      <app-sign-in />
    } @else if (arranging()) {
      <div class="home">
        <header>
          <h1>Arrange Home</h1>
          <button type="button" class="done" (click)="done()">Done</button>
        </header>
        <main>
          <div class="write card faded" aria-hidden="true">
            <app-icon name="write" [size]="20" />
            <span>Plant a thought</span>
          </div>
          <div class="right-now card faded" aria-hidden="true">
            <app-icon name="right-now" />
            <span class="name">Right Now</span>
          </div>
          <ul class="tiles" aria-label="Tiles, drag to reorder" aria-describedby="arrange-hint">
            @for (t of tiles(); track t.id) {
              <li
                class="tile card"
                [class.lifted]="drag()?.id === t.id"
                [style.transform]="offset(t.id)"
              >
                <button
                  type="button"
                  class="grip"
                  [attr.data-id]="t.id"
                  [attr.aria-label]="'Move ' + t.name"
                  (pointerdown)="grab($event, t.id)"
                  (pointermove)="dragTo($event)"
                  (pointerup)="drop()"
                  (pointercancel)="endDrag()"
                  (lostpointercapture)="endDrag()"
                  (keydown)="key($event, t.id)"
                >
                  <app-icon name="grip" [size]="18" />
                </button>
                <app-icon [name]="t.icon" [size]="28" />
                <span class="name">{{ t.name }}</span>
                <button
                  type="button"
                  class="small"
                  [attr.aria-label]="'Remove ' + t.name"
                  (click)="remove(t)"
                >
                  Remove
                </button>
              </li>
            }
            @if (drag(); as d) {
              @let slot = d.slots[d.order.indexOf(d.id)];
              <li
                class="drop"
                aria-hidden="true"
                [style.left.px]="slot.x"
                [style.top.px]="slot.y"
                [style.width.px]="slot.w"
                [style.height.px]="slot.h"
              ></li>
            }
          </ul>
          <section aria-labelledby="not-on-home">
            <h2 id="not-on-home">Not on Home</h2>
            @for (t of notOnHome(); track t.id) {
              <div class="off card">
                <app-icon [name]="t.icon" [size]="22" />
                <span class="off-name">{{ t.name }}</span>
                <button
                  type="button"
                  class="small"
                  [attr.aria-label]="'Add ' + t.name"
                  (click)="add(t)"
                >
                  Add
                </button>
              </div>
            } @empty {
              <p class="hint">Every tile is on Home.</p>
            }
          </section>
          <p class="hint" id="arrange-hint">
            Hold a tile on Home to get here. The grip also moves it by keyboard: focus it and use
            the arrows.
          </p>
          <p class="visually-hidden" aria-live="polite">{{ said() }}</p>
        </main>
      </div>
    } @else {
      <div class="home">
        <header>
          <app-icon name="leaf" [size]="26" />
          <!-- New note (#272), just right of the leaf, as on every screen. -->
          <app-new-note />
          <h1>Mossgoblin</h1>
          <span class="sync" role="status">
            <span class="dot" [class.offline]="!online()" aria-hidden="true"></span>
            {{ online() ? 'Synced' : 'Offline' }}
          </span>
          <a class="icon-link" routerLink="/settings" aria-label="Settings">
            <app-icon name="settings" [size]="22" />
          </a>
        </header>
        <main>
          <app-share-waiting class="share-waiting" />
          <!-- A link, not a field: it never holds typing. The editor at /
               takes the cursor as it opens (autofocus). -->
          <a class="write card" routerLink="/">
            <app-icon name="write" [size]="20" />
            <span>Plant a thought</span>
          </a>
          <a class="right-now card" routerLink="/right-now">
            <app-icon name="right-now" />
            <span class="text">
              <span class="name">Right Now</span>
              <span class="status" [class.empty]="rightNowEmpty()">{{ rightNow() }}</span>
            </span>
            <app-icon name="chevron" [size]="18" />
          </a>
          <nav aria-label="Modules">
            @for (t of tiles(); track t.id) {
              <a
                class="tile card"
                [routerLink]="t.link"
                (pointerdown)="press($event)"
                (pointermove)="pressMove($event)"
                (pointerup)="release()"
                (pointercancel)="release()"
                (pointerleave)="release()"
                (click)="clicked($event)"
                (contextmenu)="clicked($event)"
              >
                <app-icon [name]="t.icon" [size]="28" />
                <span class="text">
                  <span class="name">{{ t.name }}</span>
                  <span class="status" [class.empty]="t.empty">{{ t.status }}</span>
                </span>
              </a>
            }
          </nav>
          @if (showHint()) {
            <p class="hint">Tap the box to write; it opens the editor.</p>
          }
          <button type="button" class="arrange" (click)="startArranging()">Arrange Home</button>
        </main>
      </div>
    }
  `,
  styles: `
    .home {
      max-width: 640px;
      margin: 0 auto;
      padding: 0 var(--space-3) var(--space-3);
    }
    header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: var(--space-3) 0 var(--space-2);
    }
    h1 {
      flex: 1;
      margin: 0;
      font-size: 20px;
    }
    .sync {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--quiet);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--good);
    }
    .dot.offline {
      background: var(--warn);
    }
    .icon-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border-radius: var(--radius-control);
    }
    main {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    a {
      color: var(--ink);
      text-decoration: none;
    }
    .card {
      box-sizing: border-box;
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-card);
    }
    .write {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 52px;
      padding: 0 14px;
      font-size: 17px;
      color: var(--quiet);
      cursor: text;
    }
    .right-now {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
    }
    .text {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .name {
      font-size: 16px;
      font-weight: 600;
    }
    /* A line with something in it is in ink; one with nothing in the
       quiet ink, still AA on the card (#288). */
    .status {
      font-size: 14px;
      color: var(--ink);
    }
    .status.empty {
      color: var(--quiet);
    }
    nav {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .tile {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 108px;
      padding: 14px;
    }
    .tile .status {
      font-size: 13px;
    }
    nav .tile {
      /* A hold opens Arrange Home, not the link's menu. */
      -webkit-touch-callout: none;
      user-select: none;
    }
    .arrange,
    .small,
    .done {
      font: inherit;
      min-height: 44px;
      padding: 0 14px;
      border-radius: var(--radius-control);
      cursor: pointer;
    }
    .arrange {
      align-self: center;
      border: 0;
      background: transparent;
      color: var(--accent);
      font-size: 15px;
    }
    .done {
      border: 0;
      background: var(--accent);
      color: var(--on-accent);
      font-size: 15px;
      font-weight: 600;
    }
    .small {
      font-size: 14px;
      padding: 0 12px;
      border: var(--border) solid var(--rule);
      background: transparent;
      color: var(--ink);
    }
    /* They stay put. Not faded: their words keep their contrast. */
    .faded {
      border-style: dashed;
      background: transparent;
      color: var(--quiet);
    }
    .tiles {
      position: relative;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .tiles .tile {
      position: relative;
      transition:
        transform var(--motion) ease-out,
        box-shadow var(--motion) ease-out;
    }
    .tiles .small {
      align-self: flex-start;
      margin-top: auto;
    }
    .grip {
      position: absolute;
      top: 4px;
      right: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-control);
      background: transparent;
      cursor: grab;
      /* The grip's drag is the app's, not the page's scroll. */
      touch-action: none;
    }
    .lifted {
      z-index: 1;
      border: 2px dashed var(--accent);
      box-shadow: 0 10px 24px color-mix(in srgb, var(--ink) 18%, transparent);
      rotate: -2deg;
      /* It follows the pointer; only the others glide. */
      transition: box-shadow var(--motion) ease-out;
    }
    .lifted .grip {
      cursor: grabbing;
    }
    .drop {
      position: absolute;
      box-sizing: border-box;
      border: 2px dashed var(--rule);
      border-radius: var(--radius-card);
      background: color-mix(in srgb, var(--second) 10%, transparent);
    }
    @media (prefers-reduced-motion: reduce) {
      .lifted {
        rotate: none;
      }
    }
    section {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    h2 {
      margin: 0;
      font-size: 13px;
      font-weight: 400;
      color: var(--quiet);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .off {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 4px 4px 4px 14px;
    }
    .off-name {
      flex: 1;
      font-size: 15px;
    }
    .hint {
      margin: var(--space-2) 0 0;
      font-size: 13px;
      color: var(--quiet);
      text-align: center;
    }
  `,
})
export class Home {
  protected readonly auth = inject(AuthService);
  private readonly notes = inject(NotesService);
  private readonly modules = inject(ModulesService);
  private readonly reminders = inject(RemindersService);
  private readonly items = inject(ItemsService);
  private readonly reader = inject(ReaderService);
  private readonly player = inject(PlayerService);
  private readonly fresh = inject(FreshCounts);
  private readonly places = inject(PlacesService);
  private readonly grocery = inject(GroceryService);
  private readonly habits = inject(HabitsService);
  private readonly activity = inject(ACTIVITY_API);
  private readonly fb = inject(FIREBASE);
  private readonly now = inject(NOW);
  private readonly homeTiles = inject(HomeTilesService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly online = signal(navigator.onLine);
  /** When the assistants' latest runs were, in milliseconds. */
  private readonly runs = signal<number[]>([]);
  /** Arrange Home (#222) is open. */
  protected readonly arranging = signal(false);
  /** The tile being dragged, while it is. */
  protected readonly drag = signal<Drag | undefined>(undefined);
  /** What the last move did, for the live region. */
  protected readonly said = signal('');
  /** A tile being held, until HOLD_MS opens Arrange Home. */
  private hold?: { timer: ReturnType<typeof setTimeout>; x: number; y: number };
  /**
   * A hold opened Arrange Home and the finger is still down: the click
   * that ends it lands on whatever is now under it, and is not a tap.
   */
  private held = false;
  /** Where on its tile the dragged one was taken, relative to its slot. */
  private grip?: { x: number; y: number; list: HTMLElement };

  /**
   * The first reminder or two that are overdue or due today, then what is
   * new in the Reader and Podcasts since he last looked. A later day's
   * reminder waits for its day (Eric, 2026-11-11): one worded "tonight"
   * read wrong the day before. "Since you last looked" (#288) keeps the
   * count from reading as the Reader tile's unread, a different number.
   */
  private readonly rightNowParts = computed(() => {
    const parts = this.reminders
      .due()
      .slice(0, HOME_REMINDERS)
      .map((r) => r.text);
    const fresh = sinceLooked(this.fresh.reader(), this.fresh.podcasts());
    return fresh ? [...parts, fresh] : parts;
  });
  protected readonly rightNow = computed(() =>
    this.rightNowParts().length
      ? this.rightNowParts().join(' · ')
      : 'Nothing to tend. The garden is quiet.',
  );
  protected readonly rightNowEmpty = computed(() => this.rightNowParts().length === 0);
  /** What Browse's Recent lists: the notes with something written. */
  private readonly liveNotes = computed(() =>
    this.notes.notes().filter((n) => inLens('recent', n)),
  );
  /**
   * "Tap the box to write" is for someone new (#288): shown once the
   * notes are known, while there are fewer than HINT_UNTIL_NOTES, and
   * not again once there are that many (unless enough are deleted).
   */
  protected readonly showHint = computed(
    () => this.notes.loaded() && this.liveNotes().length < HINT_UNTIL_NOTES,
  );

  /** Home's tiles as arranged (#222), and those taken off. */
  private readonly layout = computed(() => {
    const all = this.allTiles();
    const by = new Map(all.map((t) => [t.id, t]));
    const { shown, off } = arrange(
      this.homeTiles.arrangement(),
      all.map((t) => t.id),
    );
    return { shown, tiles: shown.map((id) => by.get(id)!), off: off.map((id) => by.get(id)!) };
  });
  protected readonly tiles = computed(() => this.layout().tiles);
  protected readonly notOnHome = computed(() => this.layout().off);

  /**
   * Every tile of a module that is on, in the default order (TILE_IDS),
   * named, drawn and counted as the rail's entries are (`places.ts`).
   */
  private readonly allTiles = computed<Tile[]>(() =>
    this.places.tiles().map((id) => ({ id, ...PLACES[id], ...this.line(id) })),
  );

  /** A tile's status line, and whether there is nothing in it (#288). */
  private line(id: (typeof TILE_IDS)[number]): { status: string; empty: boolean } {
    switch (id) {
      case 'notes':
        return { status: this.notesLine(), empty: this.liveNotes().length === 0 };
      case 'habits':
        return this.habitsLine();
      case 'kitchen':
        return this.kitchenLine();
      case 'reader': {
        const unread = this.places.readerUnread();
        return { status: `${unread} unread`, empty: unread === 0 };
      }
      case 'podcasts':
        return this.podcastsLine();
      case 'reading': {
        const toRead = this.places.toRead();
        return { status: toRead ? `${toRead} to read` : 'Nothing waiting', empty: toRead === 0 };
      }
      case 'assistants': {
        const today = this.startOfToday();
        const runsToday = this.runs().filter((at) => at >= today).length;
        const open = this.places.suggestions();
        return {
          status: [
            plural(open, 'suggestion', 'suggestions'),
            ...(runsToday ? [`${plural(runsToday, 'run', 'runs')} today`] : []),
          ].join(' · '),
          empty: open === 0 && runsToday === 0,
        };
      }
      case 'map':
        // A description, not a count: quiet, as a line with nothing in it.
        return { status: 'The whole garden', empty: true };
    }
  }

  constructor() {
    // The runs, as What assistants changed lists them, for how many today.
    let stop: (() => void) | undefined;
    effect(() => {
      const uid = this.auth.user()?.uid;
      stop?.();
      stop = undefined;
      this.runs.set([]);
      if (!uid) return;
      stop = this.activity.listen(
        this.fb.db,
        paths.activity(uid),
        (docs) =>
          this.runs.set(
            docs
              .map((d) => (d.data['at'] as { toMillis?: () => number } | undefined)?.toMillis?.())
              .filter((at): at is number => at !== undefined),
          ),
        (err) => console.error('activity listener', err),
      );
    });
    const update = () => this.online.set(navigator.onLine);
    addEventListener('online', update);
    addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      this.release();
      stop?.();
      removeEventListener('online', update);
      removeEventListener('offline', update);
    });
  }

  protected startArranging(): void {
    this.said.set('');
    this.arranging.set(true);
    this.focusAfterRender('.done');
  }

  protected done(): void {
    this.endDrag();
    this.arranging.set(false);
    this.focusAfterRender('.arrange');
  }

  /** A press on a tile: held for HOLD_MS, still, it opens Arrange Home. */
  protected press(e: PointerEvent): void {
    this.release();
    this.held = false;
    if (!e.isPrimary || e.button !== 0) return;
    this.hold = {
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        this.hold = undefined;
        this.held = true;
        addEventListener('pointerup', () => setTimeout(() => (this.held = false)), {
          once: true,
          capture: true,
        });
        this.startArranging();
      }, HOLD_MS),
    };
  }

  protected pressMove(e: PointerEvent): void {
    const h = this.hold;
    if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > HOLD_SLOP) this.release();
  }

  protected release(): void {
    if (this.hold) clearTimeout(this.hold.timer);
    this.hold = undefined;
  }

  /** The tap, or the long press's menu, that ends a hold does nothing more. */
  protected clicked(e: Event): void {
    if (this.held) e.preventDefault();
  }

  /** A grip taken: the tile lifts and follows the pointer. */
  protected grab(e: PointerEvent, id: string): void {
    if (!e.isPrimary || e.button !== 0) return;
    const button = e.currentTarget as HTMLElement;
    const list = button.closest('ul')!;
    const slots = [...list.querySelectorAll<HTMLElement>(':scope > li.tile')].map((li) => ({
      x: li.offsetLeft,
      y: li.offsetTop,
      w: li.offsetWidth,
      h: li.offsetHeight,
    }));
    const order = this.layout().shown;
    const from = slots[order.indexOf(id)];
    if (!from) return;
    e.preventDefault();
    button.setPointerCapture?.(e.pointerId);
    const box = list.getBoundingClientRect();
    this.grip = { x: e.clientX - box.left - from.x, y: e.clientY - box.top - from.y, list };
    this.drag.set({ id, order, slots, dx: 0, dy: 0 });
  }

  /** The pointer moved: the slot under it is where the tile would drop. */
  protected dragTo(e: PointerEvent): void {
    const d = this.drag();
    const g = this.grip;
    if (!d || !g) return;
    const box = g.list.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    const from = d.slots[this.layout().shown.indexOf(d.id)];
    this.drag.set({
      ...d,
      order: moveTo(d.order, d.id, nearestSlot(d.slots, x, y)),
      dx: x - g.x - from.x,
      dy: y - g.y - from.y,
    });
  }

  protected drop(): void {
    const d = this.drag();
    this.endDrag();
    if (!d || d.order.join() === this.layout().shown.join()) return;
    this.homeTiles.reorder(d.order);
    this.announce(d.id);
  }

  protected endDrag(): void {
    this.drag.set(undefined);
    this.grip = undefined;
  }

  /**
   * Where a tile is drawn while one is dragged: the dragged one under
   * the pointer, each other in the slot it would take.
   */
  protected offset(id: string): string | null {
    const d = this.drag();
    if (!d) return null;
    if (id === d.id) return `translate(${d.dx}px, ${d.dy}px)`;
    const at = d.slots[this.layout().shown.indexOf(id)];
    const to = d.slots[d.order.indexOf(id)];
    return at === to ? null : `translate(${to.x - at.x}px, ${to.y - at.y}px)`;
  }

  /** The arrows on a grip move its tile a slot: across, or a row up or down. */
  protected key(e: KeyboardEvent, id: string): void {
    const by = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS }[e.key];
    if (by === undefined) return;
    e.preventDefault();
    const next = moveBy(this.layout().shown, id, by);
    if (next) this.homeTiles.reorder(next);
    this.announce(id);
    // A moved element can lose focus; the grip keeps it.
    this.focusAfterRender(`.grip[data-id="${id}"]`);
  }

  protected remove(t: Tile): void {
    if (this.held) return;
    this.homeTiles.remove(t.id);
    this.said.set(`${t.name} taken off Home`);
    this.focusAfterRender('.done');
  }

  protected add(t: Tile): void {
    if (this.held) return;
    this.homeTiles.add(t.id, this.layout().shown);
    this.said.set(`${t.name} added to Home, at the end`);
    this.focusAfterRender(`.grip[data-id="${t.id}"]`);
  }

  private announce(id: string): void {
    const { shown, tiles } = this.layout();
    const at = shown.indexOf(id);
    this.said.set(`${tiles[at].name}, ${at + 1} of ${shown.length}`);
  }

  private focusAfterRender(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  /**
   * The Podcasts tile's line (#251): what is playing with its time
   * left, else what is new and what is in the queue (a zero part left
   * out), else how many shows, else what the module is; empty (#288)
   * when nothing plays, is new or is queued.
   */
  private podcastsLine(): { status: string; empty: boolean } {
    const it = this.player.item();
    if (it && this.player.playing() && this.reader.isPodcast(it.feedId)) {
      const total = this.player.duration();
      const left =
        total > 0 ? ` · ${this.items.duration(total - this.player.position())} left` : '';
      return { status: `Playing: ${it.title}${left}`, empty: false };
    }
    const fresh = this.places.podcastsNew();
    const queued = this.places.podcastsQueued();
    const parts = [
      ...(fresh ? [`${fresh} new`] : []),
      ...(queued ? [`${queued} in the queue`] : []),
    ];
    if (parts.length) return { status: parts.join(' · '), empty: false };
    const shows = this.reader.podcastFeeds().length;
    return { status: shows ? plural(shows, 'show', 'shows') : 'Shows and the queue', empty: true };
  }

  /**
   * The Habits tile's line (#324): how many of today's habits are done
   * or skipped, of those due ("2 of 5 today"); with none, what a habit
   * is. Empty (#288) when there is nothing left to do today.
   */
  private habitsLine(): { status: string; empty: boolean } {
    const due = this.habits.placed().filter((h) => h.due);
    if (!due.length) return { status: 'Something to do each day', empty: true };
    const settled = due.filter((h) => h.state !== 'none').length;
    return { status: `${settled} of ${due.length} today`, empty: settled === due.length };
  }

  /** Every note Browse's Recent lists, and how many were written in today. */
  private notesLine(): string {
    const live = this.liveNotes();
    const today = this.startOfToday();
    const edited = live.filter((n) => (n.updatedAt ?? 0) >= today).length;
    return `${live.length} · ${edited} today`;
  }

  /**
   * Tonight's dinner from this week's plan, and what the grocery list has
   * open; empty (#288) with nothing planned and nothing to buy.
   */
  private kitchenLine(): { status: string; empty: boolean } {
    const date = localDate(this.now());
    const plans = this.notes
      .notes()
      .filter((n) => n.kind === 'mealplan' && !n.archived && n.periodStart);
    const start = planStartFor(
      date,
      this.modules.kitchenConfig().weekStart,
      plans.map((n) => n.periodStart!).filter(isIsoDate),
    );
    const plan = plans.find((n) => n.periodStart === start);
    const slot = plan
      ? planSlots(plan.body, start).find((s) => s.date === date && s.meal === 'dinner')
      : undefined;
    const dinner = !slot?.text
      ? 'nothing planned'
      : slot.kind === 'recipe'
        ? (slot.recipe ?? slot.text)
        : slot.text;
    const parts = [`Tonight: ${dinner}`];
    const listId = this.grocery.listId();
    const list = listId ? this.notes.find(listId) : undefined;
    let open = 0;
    if (list) {
      open = checklist(list.body).reduce(
        (sum, s) => sum + s.items.filter((i) => !i.done).length,
        0,
      );
      parts.push(`${open} to buy`);
    }
    return { status: parts.join(' · '), empty: !slot?.text && open === 0 };
  }

  private startOfToday(): number {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}
