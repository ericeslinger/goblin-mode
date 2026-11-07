import { DOCUMENT } from '@angular/common';
import { Component, computed, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';
import { ItemsService, PODCASTS } from './items.service';
import { PlayerService } from './player.service';
import { ReaderService } from './reader.service';

/** The bar's height, the safe area under it included (#179). */
export const MINI_PLAYER_HEIGHT = 'calc(64px + env(safe-area-inset-bottom, 0px))';

/**
 * The mini-player (#179): a bar fixed at the foot of every screen while
 * an episode is in hand, except that episode's own page, which holds
 * the full controls. Artwork when images are on, the title (a tap opens
 * the episode), elapsed and total, back 15, play or pause, on 30, and
 * close. Another device's newer place shows as "Continue from 12:34".
 *
 * While it shows it sets `--mini-player-height` on the root, which the
 * page's bottom padding, the launch screen's height and the Reader
 * list's Undo bar (#172) read, so that bar sits above this one and
 * nothing hides under it.
 */
@Component({
  selector: 'app-mini-player',
  imports: [RouterLink],
  template: `
    @if (shown(); as it) {
      <aside class="bar" aria-label="Now playing">
        @if (it.image && reader.images()) {
          <img [src]="it.image" alt="" width="44" height="44" referrerpolicy="no-referrer" />
        }
        <span class="info">
          <a
            class="title"
            [routerLink]="['/reader/a', it.id]"
            [queryParams]="{ in: shelf }"
            [attr.aria-label]="'Open the episode: ' + it.title"
            >{{ it.title }}</a
          >
          @if (player.offer(); as at) {
            <button type="button" class="offer" (click)="player.takeOffer()">
              Continue from {{ items.clock(at) }}
            </button>
          } @else {
            <span class="time"
              >{{ items.clock(player.position()) }} / {{ items.clock(player.duration()) }}</span
            >
          }
        </span>
        <span class="controls">
          <button type="button" aria-label="Back 15 seconds" (click)="player.skip(-15)">−15</button>
          <button
            type="button"
            class="main"
            [attr.aria-label]="player.playing() ? 'Pause' : 'Play'"
            (click)="player.toggle()"
          >
            {{ player.playing() ? '❚❚' : '▶' }}
          </button>
          <button type="button" aria-label="Forward 30 seconds" (click)="player.skip(30)">
            +30
          </button>
          <button type="button" aria-label="Close the player" (click)="player.stop()">×</button>
        </span>
      </aside>
    }
  `,
  styles: `
    .bar {
      position: fixed;
      inset: auto 0 0;
      z-index: 2;
      box-sizing: border-box;
      max-width: 640px;
      /* MINI_PLAYER_HEIGHT */
      height: calc(64px + env(safe-area-inset-bottom, 0px));
      margin: 0 auto;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: var(--space-2);
      align-items: center;
      padding: 0 var(--space-2) env(safe-area-inset-bottom, 0px);
      background: var(--surface);
      color: var(--ink);
      border-top: 1px solid var(--rule);
    }
    img {
      display: block;
      border-radius: var(--radius-control);
      object-fit: cover;
    }
    .info {
      display: grid;
      min-width: 0;
      grid-column: 2;
    }
    .title {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: var(--ink);
      font-weight: 600;
      text-decoration: none;
    }
    .time {
      color: var(--quiet);
      font-size: 14px;
      font-variant-numeric: tabular-nums;
    }
    .offer {
      justify-self: start;
      min-height: 28px;
      font-size: 14px;
    }
    .controls {
      display: flex;
      gap: 4px;
    }
    .controls button {
      min-width: 40px;
      min-height: 40px;
    }
  `,
})
export class MiniPlayer {
  protected readonly player = inject(PlayerService);
  protected readonly items = inject(ItemsService);
  protected readonly reader = inject(ReaderService);
  protected readonly shelf = `f:${PODCASTS}`;
  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** The episode in hand, unless this is its own page. */
  protected readonly shown = computed(() => {
    const it = this.player.item();
    if (!it) return undefined;
    const path = this.url().split(/[?#]/)[0];
    return path === `/reader/a/${encodeURIComponent(it.id)}` ? undefined : it;
  });

  constructor() {
    const root = inject(DOCUMENT).documentElement;
    effect(() => {
      if (this.shown()) root.style.setProperty('--mini-player-height', MINI_PLAYER_HEIGHT);
      else root.style.removeProperty('--mini-player-height');
    });
  }
}
