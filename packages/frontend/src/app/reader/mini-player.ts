import { DOCUMENT } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';
import { Icon } from '../home/icon';
import { EpisodeArt } from '../podcasts/episode-art';
import { type ItemRecord, ItemsService } from './items.service';
import { PlayerService } from './player.service';
import { ReaderService } from './reader.service';

/** The bar's height, the safe area under it included (#179). */
export const MINI_PLAYER_HEIGHT = 'calc(64px + env(safe-area-inset-bottom, 0px))';

/**
 * The mini-player (#179): a bar fixed at the foot of every screen while
 * an episode is in hand, except that episode's own page, which holds
 * the full controls: in Podcasts for a show followed there, in the
 * Reader for a feed of its own (#245). Artwork when images are on, the
 * title (a tap opens the episode), elapsed and total, back 15, play or
 * pause, on 30, and close, as round icon buttons, and a 2 px line along
 * its top edge for how far along it is, drawn only (#290). Another
 * device's newer place shows as "Continue from 12:34".
 *
 * While it shows it sets `--mini-player-height` on the root, which the
 * page's bottom padding, the launch screen's height and the Reader
 * list's Undo bar (#172) read, so that bar sits above this one and
 * nothing hides under it.
 */
@Component({
  selector: 'app-mini-player',
  imports: [EpisodeArt, Icon, RouterLink],
  template: `
    @if (shown(); as it) {
      <aside class="bar" aria-label="Now playing">
        <!-- How far along, drawn only: the time beside the title says it in words. -->
        <div class="progress" role="presentation">
          <span [style.width.%]="percent()"></span>
        </div>
        <!-- The row's artwork (#290): the episode's, else its show's, else
             the show's initials on its tinted square, also when it fails. -->
        <app-episode-art [item]="it" [show]="showTitle(it)" [size]="44" />
        <span class="info">
          <a
            class="title"
            [routerLink]="pageOf(it)"
            [queryParams]="queryOf(it)"
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
          <button type="button" class="ctl" aria-label="Back 15 seconds" (click)="player.skip(-15)">
            <app-icon name="skip-back" [size]="28" />
            <span class="n" aria-hidden="true">15</span>
          </button>
          <button
            type="button"
            class="ctl main primary"
            [attr.aria-label]="player.playing() ? 'Pause' : 'Play'"
            (click)="player.toggle()"
          >
            <app-icon
              [name]="player.playing() ? 'pause-bars' : 'play'"
              [size]="20"
              [filled]="true"
              [current]="true"
            />
          </button>
          <button
            type="button"
            class="ctl"
            aria-label="Forward 30 seconds"
            (click)="player.skip(30)"
          >
            <app-icon name="skip-forward" [size]="28" />
            <span class="n" aria-hidden="true">30</span>
          </button>
          <button type="button" class="ctl" aria-label="Close the player" (click)="player.stop()">
            <app-icon name="close" [size]="20" />
          </button>
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
    /* The 2 px line along the top edge (#290), inside the bar's 64 px,
       so --mini-player-height is what it was. */
    .progress {
      position: absolute;
      inset: -1px 0 auto;
      height: 2px;
      overflow: hidden;
      pointer-events: none;
    }
    .progress span {
      display: block;
      height: 100%;
      background: var(--accent);
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
      align-items: center;
      gap: 2px;
    }
    /* Round icon buttons from the theme (#290): Play filled with the
       accent (.primary), the others the mark alone; 40 px by mouse,
       44 on a touch screen (2026-11-15). */
    .ctl {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      min-width: 40px;
      min-height: 40px;
      padding: 0;
      border-radius: 50%;
    }
    .ctl:not(.primary) {
      border-color: transparent;
      background: transparent;
    }
    .ctl:not(.primary):hover {
      background: var(--chip-bg);
    }
    .n {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding-top: 2px;
      font-family: var(--font-mono);
      font-size: 9px;
      font-weight: 600;
      color: var(--ink);
    }
    @media (pointer: coarse) {
      .ctl {
        width: 44px;
        height: 44px;
        min-width: 44px;
        min-height: 44px;
      }
    }
  `,
})
export class MiniPlayer {
  protected readonly player = inject(PlayerService);
  protected readonly items = inject(ItemsService);
  protected readonly reader = inject(ReaderService);
  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** The show's name, for the artwork's initials. */
  protected showTitle(it: ItemRecord): string {
    return this.reader.feeds().find((f) => f.id === it.feedId)?.title ?? 'A show';
  }

  /** The episode's page: Podcasts' for a show followed there (#245), else the Reader's. */
  protected pageOf(it: ItemRecord): string[] {
    return this.reader.isPodcast(it.feedId) ? ['/podcasts/e', it.id] : ['/reader/a', it.id];
  }

  /** The Reader's article page goes back to the feed's shelf. */
  protected queryOf(it: ItemRecord): Record<string, string> | null {
    return this.reader.isPodcast(it.feedId) ? null : { in: `s:${it.feedId}` };
  }

  /** How far along the episode in hand is, for the line along the top. */
  protected readonly percent = computed(() => {
    const total = this.player.duration();
    return total > 0 ? Math.min(100, Math.max(0, (this.player.position() / total) * 100)) : 0;
  });

  /** The episode in hand, unless this is its own page, in either module. */
  protected readonly shown = computed(() => {
    const it = this.player.item();
    if (!it) return undefined;
    const path = this.url().split(/[?#]/)[0];
    const id = encodeURIComponent(it.id);
    return path === `/reader/a/${id}` || path === `/podcasts/e/${id}` ? undefined : it;
  });

  constructor() {
    const root = inject(DOCUMENT).documentElement;
    effect(() => {
      if (this.shown()) root.style.setProperty('--mini-player-height', MINI_PLAYER_HEIGHT);
      else root.style.removeProperty('--mini-player-height');
    });
    // Close puts the episode down, and the shell then removes this
    // component (behind PlayerPresence) before the effect above runs
    // again, which left the room set after the bar had gone (#290).
    inject(DestroyRef).onDestroy(() => root.style.removeProperty('--mini-player-height'));
  }
}
