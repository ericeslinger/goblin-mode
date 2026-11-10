import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../home/icon';
import { moveBy, moveTo } from '../home/home-tiles';
import { DownloadsService } from '../reader/downloads.service';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { PlayerService } from '../reader/player.service';
import { ReaderService } from '../reader/reader.service';
import { EpisodeArt } from './episode-art';
import { lengthText, totalText } from './episodes';
import { PodcastsBar } from './podcasts-bar';

/** A row being dragged by its grip: the order it would drop in, and how far it moved. */
interface Drag {
  id: string;
  /** Up next as it was when the grip was taken. */
  start: string[];
  /** Where the row would drop now. */
  order: string[];
  /** Each row's top and height at the start, relative to the list. */
  tops: Map<string, number>;
  heights: Map<string, number>;
  /** The space between two rows. */
  gap: number;
  /** Where the pointer was taken, and how far it has moved since. */
  y: number;
  dy: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The Queue (#249, step 3 of #244; Eric 2026-11-10: "A listening queue
 * that new episodes append to, but can be rearranged"), at
 * `/podcasts/queue`: Now playing, the player's episode with its
 * progress and time left, then Up next, the listening queue in its
 * order without the one playing, with how many and how long is left
 * of them. Each row has a grip, its artwork, its title (opening its
 * page), its show and length, and More.
 *
 * Arranging follows Arrange Home's tiles (#222): the grip drags its
 * row (pointer events, touch and mouse; the row lifts and a dashed
 * slot shows where it lands; `touch-action: none` keeps the page
 * still), and with the grip focused Arrow Up and Arrow Down move it a
 * place, said in a polite live region. More is a small menu of
 * buttons (Play, Move up, Move down, Play next, Remove from the
 * queue): Escape closes it and focus goes back to More. Every write
 * goes through the cache at once (`ItemsService`).
 */
@Component({
  selector: 'app-podcasts-queue',
  imports: [EpisodeArt, Icon, PodcastsBar, RouterLink],
  host: {
    '(document:pointerdown)': 'outside($event)',
    '(focusin)': 'focused($event)',
  },
  template: `
    <main class="page">
      <app-podcasts-bar active="queue" />
      @if (nowPlaying(); as it) {
        <section class="now" aria-labelledby="now-playing">
          <h2 id="now-playing">Now playing</h2>
          <div class="card playing">
            <app-episode-art [item]="it" [show]="showTitle(it)" [size]="56" />
            <a class="open" [routerLink]="['/podcasts/e', it.id]">
              <span class="title">{{ it.title }}</span>
              <span class="meta"
                >{{ showTitle(it) }}
                @if (nowLeft(); as left) {
                  · {{ left }}
                }
              </span>
              <span class="progress" aria-hidden="true"
                ><span [style.width.%]="nowDone()"></span
              ></span>
            </a>
          </div>
        </section>
      }
      <section class="next" aria-labelledby="up-next">
        <div class="head">
          <h2 id="up-next">Up next</h2>
          @if (totalLine(); as line) {
            <span class="meta">{{ line }}</span>
          }
        </div>
        @if (items.loaded() && upNext().length === 0) {
          <p class="muted">
            Nothing up next. Add an episode with its queue button
            <app-icon name="queue-add" [size]="16" /> in <a routerLink="/podcasts">Latest</a> or on
            a show's page, or switch on New episodes join the queue for a show.
          </p>
        }
        <ul
          class="rows"
          aria-label="Up next, drag to reorder"
          [attr.aria-describedby]="upNext().length ? 'queue-hint' : null"
        >
          @for (ep of upNext(); track ep.id; let n = $index, last = $last) {
            <li
              class="row"
              [attr.data-id]="ep.id"
              [class.lifted]="drag()?.id === ep.id"
              [style.transform]="offset(ep.id)"
            >
              <button
                type="button"
                class="grip"
                [attr.data-id]="ep.id"
                [attr.aria-label]="'Move ' + ep.title"
                (pointerdown)="grab($event, ep.id)"
                (pointermove)="dragTo($event)"
                (pointerup)="drop()"
                (pointercancel)="endDrag()"
                (lostpointercapture)="endDrag()"
                (keydown)="key($event, ep)"
              >
                <app-icon name="grip" [size]="18" />
              </button>
              <app-episode-art [item]="ep" [show]="showTitle(ep)" [size]="44" />
              <a class="open" [routerLink]="['/podcasts/e', ep.id]">
                <span class="title">{{ ep.title }}</span>
                <span class="meta"
                  >{{ showTitle(ep) }}
                  @if (length(ep); as l) {
                    · {{ l }}
                  }
                  @if (downloads.has(ep.id)) {
                    · downloaded
                  }
                </span>
              </a>
              <button
                type="button"
                class="more"
                [attr.data-more]="ep.id"
                [attr.aria-label]="'More for ' + ep.title"
                [attr.aria-expanded]="menu() === ep.id"
                [attr.aria-controls]="menu() === ep.id ? 'queue-menu' : null"
                (click)="toggleMenu(ep.id)"
                (keydown.escape)="closeMenu(ep.id)"
              >
                <app-icon name="more" [size]="22" />
              </button>
              @if (menu() === ep.id) {
                <div
                  class="menu"
                  id="queue-menu"
                  role="group"
                  [attr.aria-label]="'More for ' + ep.title"
                  (keydown.escape)="closeMenu(ep.id)"
                >
                  <button type="button" (click)="play(ep)">Play</button>
                  <button type="button" [disabled]="n === 0" (click)="moveFromMenu(ep, -1)">
                    Move up
                  </button>
                  <button type="button" [disabled]="last" (click)="moveFromMenu(ep, 1)">
                    Move down
                  </button>
                  <button type="button" [disabled]="n === 0" (click)="next(ep)">Play next</button>
                  <button type="button" (click)="remove(ep)">Remove from the queue</button>
                </div>
              }
            </li>
          }
          @if (drag(); as d) {
            <li
              class="drop"
              aria-hidden="true"
              [style.top.px]="topIn(d, d.order, d.id)"
              [style.height.px]="d.heights.get(d.id)"
            ></li>
          }
        </ul>
        @if (upNext().length) {
          <p class="hint" id="queue-hint">
            Drag a row by its grip, or focus the grip and use Arrow Up and Arrow Down.
          </p>
        }
        <p class="visually-hidden" aria-live="polite">{{ said() }}</p>
      </section>
    </main>
  `,
  styles: `
    section {
      display: grid;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    h2 {
      margin: 0;
      font-size: 13px;
      font-weight: 400;
      color: var(--quiet);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2);
    }
    .head h2 {
      flex: 1;
    }
    .playing,
    .row {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-card);
    }
    .playing {
      padding: 10px 12px;
    }
    .open {
      flex: 1;
      min-width: 0;
      display: grid;
      gap: 2px;
      padding: 2px 0;
      color: var(--ink);
      text-decoration: none;
    }
    .title {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .meta,
    .muted,
    .hint {
      color: var(--quiet);
      font-size: 14px;
    }
    .muted app-icon {
      vertical-align: middle;
    }
    .progress {
      display: flex;
      height: 3px;
      margin-top: 4px;
      border-radius: 999px;
      background: var(--rule);
      overflow: hidden;
    }
    .progress span {
      background: var(--accent);
    }
    .rows {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .row {
      position: relative;
      min-height: 68px;
      padding: 6px 2px;
      transition:
        transform var(--motion) ease-out,
        box-shadow var(--motion) ease-out;
    }
    .grip,
    .more {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 44px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-control);
      background: transparent;
      cursor: pointer;
    }
    .grip {
      width: 36px;
      cursor: grab;
      /* The grip's drag is the app's, not the page's scroll. */
      touch-action: none;
    }
    .more {
      width: 44px;
    }
    .more[aria-expanded='true'] {
      background: var(--chip-bg);
    }
    .lifted {
      z-index: 1;
      border: 2px dashed var(--accent);
      box-shadow: 0 10px 24px color-mix(in srgb, var(--ink) 18%, transparent);
      rotate: -1.5deg;
      /* It follows the pointer; only the others glide. */
      transition: box-shadow var(--motion) ease-out;
    }
    .lifted .grip {
      cursor: grabbing;
    }
    .drop {
      position: absolute;
      left: 0;
      right: 0;
      box-sizing: border-box;
      border: 2px dashed var(--rule);
      border-radius: var(--radius-card);
      background: color-mix(in srgb, var(--second) 10%, transparent);
    }
    .menu {
      position: absolute;
      top: calc(100% - 6px);
      right: 4px;
      z-index: 3;
      display: grid;
      gap: 4px;
      min-width: 12rem;
      max-width: calc(100vw - 48px);
      padding: var(--space-2);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-card);
      box-shadow: 0 10px 24px color-mix(in srgb, var(--ink) 18%, transparent);
    }
    .menu button {
      min-height: 44px;
      padding: 0 12px;
      font: inherit;
      text-align: left;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      cursor: pointer;
    }
    .menu button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .hint {
      margin: 0;
    }
    @media (prefers-reduced-motion: reduce) {
      .lifted {
        rotate: none;
      }
    }
  `,
})
export class PodcastsQueue {
  protected readonly items = inject(ItemsService);
  protected readonly downloads = inject(DownloadsService);
  private readonly reader = inject(ReaderService);
  private readonly player = inject(PlayerService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  /**
   * The grip that moved its row by the keys and should keep the focus:
   * a row that changes place is put back in the page, which drops it,
   * and the list can settle again when the write comes back.
   */
  private readonly held = signal<string | undefined>(undefined);

  constructor() {
    effect(() => {
      this.upNext();
      const id = untracked(this.held);
      if (id) this.focusAfterRender(`.grip[data-id="${CSS.escape(id)}"]`);
    });
  }

  /** Focus taken somewhere else lets the grip go. */
  protected focused(e: FocusEvent): void {
    const id = this.held();
    const at = e.target as HTMLElement | null;
    if (id && !(at?.classList.contains('grip') && at.dataset['id'] === id))
      this.held.set(undefined);
  }

  /** The row being dragged, while it is. */
  protected readonly drag = signal<Drag | undefined>(undefined);
  /** The row whose More is open. */
  protected readonly menu = signal<string | undefined>(undefined);
  /** What the last change did, for the live region. */
  protected readonly said = signal('');

  /** The episode in the player, playing or paused. */
  protected readonly nowPlaying = computed(() => this.player.item());
  /** Up next: the queue in its order, without the one in the player. */
  protected readonly upNext = computed(() => {
    const current = this.player.current();
    return this.items.queue().filter((i) => i.id !== current);
  });
  private readonly ids = computed(() => this.upNext().map((i) => i.id));

  /** How much of the one playing is done, per cent, for its bar. */
  protected readonly nowDone = computed(() => {
    const total = this.player.duration();
    return total > 0 ? Math.min(100, (this.player.position() / total) * 100) : 0;
  });
  protected readonly nowLeft = computed(() => {
    const it = this.nowPlaying();
    return it ? this.length(it) : undefined;
  });

  /** "4 episodes · 4 h 7 min" (#251): what is left of each, where its length is known. */
  protected readonly totalLine = computed(() => {
    const list = this.upNext();
    if (!list.length) return undefined;
    const seconds = list.reduce((sum, i) => sum + left(i), 0);
    const n = plural(list.length, 'episode', 'episodes');
    return seconds > 0 ? `${n} · ${totalText(seconds)}` : n;
  });

  protected showTitle(ep: ItemRecord): string {
    return this.reader.feeds().find((f) => f.id === ep.feedId)?.title ?? 'A show';
  }

  protected length(ep: ItemRecord): string | undefined {
    return lengthText(ep, this.player, (s) => this.items.duration(s));
  }

  // The drag (#222's pattern): the grip lifts the row, the others glide
  // to the places they would take, and the dashed slot is where it lands.

  protected grab(e: PointerEvent, id: string): void {
    if (!e.isPrimary || e.button !== 0) return;
    const button = e.currentTarget as HTMLElement;
    const list = button.closest('ul');
    if (!list) return;
    const rows = [...list.querySelectorAll<HTMLElement>(':scope > li.row')];
    const tops = new Map<string, number>();
    const heights = new Map<string, number>();
    for (const li of rows) {
      const at = li.dataset['id'] ?? '';
      tops.set(at, li.offsetTop);
      heights.set(at, li.offsetHeight);
    }
    if (!tops.has(id)) return;
    const gap = rows[1] ? rows[1].offsetTop - rows[0].offsetTop - rows[0].offsetHeight : 0;
    e.preventDefault();
    button.setPointerCapture?.(e.pointerId);
    this.menu.set(undefined);
    const start = this.ids();
    this.drag.set({
      id,
      start,
      order: start,
      tops,
      heights,
      gap: Math.max(0, gap),
      y: e.clientY,
      dy: 0,
    });
  }

  /** The pointer moved: the row follows it, and lands past every row whose middle it passed. */
  protected dragTo(e: PointerEvent): void {
    const d = this.drag();
    if (!d) return;
    const dy = e.clientY - d.y;
    const middle = (d.tops.get(d.id) ?? 0) + dy + (d.heights.get(d.id) ?? 0) / 2;
    const passed = d.start.filter(
      (x) => x !== d.id && (d.tops.get(x) ?? 0) + (d.heights.get(x) ?? 0) / 2 < middle,
    ).length;
    this.drag.set({ ...d, dy, order: moveTo(d.start, d.id, passed) });
  }

  protected drop(): void {
    const d = this.drag();
    this.endDrag();
    if (!d || d.order.join() === d.start.join()) return;
    this.items.moveInQueue(d.id, d.order);
    this.moved(d.id, d.order);
  }

  protected endDrag(): void {
    this.drag.set(undefined);
  }

  /** A row's top in an order, the rows stacked as they are drawn. */
  protected topIn(d: Drag, order: readonly string[], id: string): number {
    let top = Math.min(...d.tops.values());
    for (const x of order) {
      if (x === id) break;
      top += (d.heights.get(x) ?? 0) + d.gap;
    }
    return top;
  }

  /** Where a row is drawn while one is dragged: under the pointer, or in the place it would take. */
  protected offset(id: string): string | null {
    const d = this.drag();
    if (!d) return null;
    if (id === d.id) return `translateY(${d.dy}px)`;
    const by = this.topIn(d, d.order, id) - (d.tops.get(id) ?? 0);
    return by ? `translateY(${by}px)` : null;
  }

  /** Arrow Up and Arrow Down on a grip move its row a place. */
  protected key(e: KeyboardEvent, ep: ItemRecord): void {
    const by = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (by === undefined) return;
    e.preventDefault();
    this.held.set(ep.id);
    this.moveBy(ep, by);
    this.focusAfterRender(`.grip[data-id="${CSS.escape(ep.id)}"]`);
  }

  private moveBy(ep: ItemRecord, by: number): void {
    const next = moveBy(this.ids(), ep.id, by);
    if (!next) {
      const at = this.ids().indexOf(ep.id);
      this.said.set(`${ep.title} stays at ${at + 1} of ${this.ids().length}`);
      return;
    }
    this.items.moveInQueue(ep.id, next);
    this.moved(ep.id, next);
  }

  private moved(id: string, order: readonly string[]): void {
    const title = this.upNext().find((i) => i.id === id)?.title ?? '';
    this.said.set(`Moved ${title} to ${order.indexOf(id) + 1} of ${order.length}`);
  }

  // More: a small menu of buttons on the row.

  protected toggleMenu(id: string): void {
    if (this.menu() === id) return this.closeMenu(id);
    this.menu.set(id);
    afterNextRender(
      () =>
        this.host.nativeElement.querySelector<HTMLElement>('#queue-menu button:enabled')?.focus(),
      { injector: this.injector },
    );
  }

  /** Escape, or a choice made: the menu closes and focus goes back to its More. */
  protected closeMenu(id: string): void {
    if (this.menu() !== id) return;
    this.menu.set(undefined);
    this.focusMore(id);
  }

  /** A press outside the open menu and its More closes it, focus left where it went. */
  protected outside(e: Event): void {
    const id = this.menu();
    if (!id) return;
    const target = e.target as Element | null;
    if (target?.closest?.('#queue-menu, .more[aria-expanded="true"]')) return;
    this.menu.set(undefined);
  }

  protected play(ep: ItemRecord): void {
    this.closeMenu(ep.id);
    // From its row: the others stay where they are (#249).
    this.player.load(ep, { autoplay: true });
    this.said.set(`Playing ${ep.title}`);
    this.focusAfterRender('#now-playing');
  }

  protected moveFromMenu(ep: ItemRecord, by: -1 | 1): void {
    this.menu.set(undefined);
    this.moveBy(ep, by);
    this.focusMore(ep.id);
  }

  protected next(ep: ItemRecord): void {
    this.menu.set(undefined);
    this.said.set(this.items.playNext(ep.id) ?? `${ep.title} plays next`);
    this.focusMore(ep.id);
  }

  protected remove(ep: ItemRecord): void {
    const ids = this.ids();
    const after = ids[ids.indexOf(ep.id) + 1] ?? ids[ids.indexOf(ep.id) - 1];
    this.menu.set(undefined);
    this.items.removeFromQueue(ep.id);
    this.said.set(`Removed ${ep.title} from the queue`);
    if (after) this.focusMore(after);
    else this.focusAfterRender('#up-next');
  }

  private focusMore(id: string): void {
    this.focusAfterRender(`.more[data-more="${CSS.escape(id)}"]`);
  }

  private focusAfterRender(selector: string): void {
    afterNextRender(
      () => {
        const el = this.host.nativeElement.querySelector<HTMLElement>(selector);
        if (el && !el.matches('button, a, input')) el.tabIndex = -1;
        el?.focus();
      },
      { injector: this.injector },
    );
  }
}

/** What is left of an episode, in seconds: its length less its kept place, where known. */
function left(ep: ItemRecord): number {
  const total = ep.enclosure?.seconds ?? 0;
  const at = ep.played ? 0 : (ep.position ?? 0);
  return Math.max(0, total - at);
}
