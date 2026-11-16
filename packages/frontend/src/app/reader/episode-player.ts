import { Component, computed, inject, input, signal } from '@angular/core';
import { Icon } from '../home/icon';
import { DownloadsService, size } from './downloads.service';
import { type ItemRecord, ItemsService } from './items.service';
import { PlayerService } from './player.service';

/**
 * An episode's full controls (#179), on its page: the Position slider
 * across the width with elapsed and total at its ends, then back 15, a
 * big round play or pause and on 30, the speed under them (#290),
 * Continue from another device's newer place, and how its download
 * stands (#180). The Reader's article and Podcasts' episode page (#245)
 * both hold it; the player's state once the episode is in hand, the
 * kept place until then.
 */
@Component({
  selector: 'app-episode-player',
  imports: [Icon],
  template: `
    @let it = item();
    <section class="player" aria-label="Player" data-no-swipe>
      <input
        type="range"
        class="position"
        aria-label="Position"
        min="0"
        step="1"
        [max]="duration()"
        [value]="shownAt()"
        [style.--at]="shownPercent() + '%'"
        [attr.aria-valuetext]="items.clock(shownAt()) + ' of ' + items.clock(duration())"
        (input)="scrub.set(+$any($event.target).value)"
        (change)="seekTo(it, $event)"
      />
      <span class="times">
        <span class="elapsed">{{ items.clock(shownAt()) }}</span>
        <span class="visually-hidden"> of </span>
        <span class="total">{{ items.clock(duration()) }}</span>
      </span>
      <span class="transport">
        <button type="button" class="skip" aria-label="Back 15 seconds" (click)="skip(it, -15)">
          <app-icon name="skip-back" [size]="32" />
          <span class="n" aria-hidden="true">15</span>
        </button>
        <button
          type="button"
          class="main primary"
          [attr.aria-label]="playing() ? 'Pause' : 'Play'"
          (click)="toggle(it)"
        >
          <app-icon
            [name]="playing() ? 'pause-bars' : 'play'"
            [size]="30"
            [filled]="true"
            [current]="true"
          />
        </button>
        <button type="button" class="skip" aria-label="Forward 30 seconds" (click)="skip(it, 30)">
          <app-icon name="skip-forward" [size]="32" />
          <span class="n" aria-hidden="true">30</span>
        </button>
      </span>
      <span class="speed">
        <button type="button" [attr.aria-label]="'Speed ' + rateText()" (click)="player.nextRate()">
          {{ rateText() }}
        </button>
      </span>
      @if (isCurrent() && player.offer(); as at) {
        <button type="button" class="offer" (click)="player.takeOffer()">
          Continue from {{ items.clock(at) }}
        </button>
      }
      @if (it.played) {
        <p class="muted">Played to the end.</p>
      }
      @if (downloaded(); as kept) {
        <p class="muted">Downloaded, {{ sizeOf(kept.bytes) }}</p>
      } @else if (progress(); as p) {
        <p class="muted" role="status">Downloading… {{ progressText(p) }}</p>
      }
    </section>
  `,
  styles: `
    .player {
      display: grid;
      gap: var(--space-2);
      margin: var(--space-3) 0;
      padding: var(--space-3);
      background: var(--surface);
      border: 1px solid var(--rule);
      border-radius: var(--radius-card);
    }
    /* The Position slider (#290): still the native range, full width,
       44 px tall for a thumb, its track and 24 px thumb drawn from the
       theme's tokens; the part played is the accent, up to --at. */
    .position {
      -webkit-appearance: none;
      appearance: none;
      display: block;
      box-sizing: border-box;
      width: 100%;
      height: 44px;
      margin: 0;
      padding: 0;
      background: transparent;
      cursor: pointer;
    }
    .position:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: var(--radius-control);
    }
    .position::-webkit-slider-runnable-track {
      height: 6px;
      border-radius: 3px;
      background: linear-gradient(
        to right,
        var(--accent) 0 var(--at, 0%),
        var(--rule) var(--at, 0%) 100%
      );
    }
    .position::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      box-sizing: border-box;
      width: 24px;
      height: 24px;
      margin-top: -9px;
      border: 2px solid var(--surface);
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 1px var(--rule);
    }
    .position::-moz-range-track {
      height: 6px;
      border-radius: 3px;
      background: var(--rule);
    }
    .position::-moz-range-progress {
      height: 6px;
      border-radius: 3px;
      background: var(--accent);
    }
    .position::-moz-range-thumb {
      box-sizing: border-box;
      width: 24px;
      height: 24px;
      border: 2px solid var(--surface);
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 1px var(--rule);
    }
    .times {
      display: flex;
      justify-content: space-between;
      margin-top: -6px;
      color: var(--quiet);
      font-size: 14px;
      font-variant-numeric: tabular-nums;
    }
    .transport {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-4);
      margin-top: var(--space-1);
    }
    .transport button {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border-radius: 50%;
    }
    .main {
      width: 64px;
      height: 64px;
    }
    .skip {
      width: 52px;
      height: 52px;
      background: transparent;
    }
    .n {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding-top: 2px;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      color: var(--ink);
    }
    .speed {
      display: flex;
      justify-content: center;
    }
    .speed button {
      min-width: 64px;
      min-height: 36px;
      border-radius: var(--radius-pill);
      font-variant-numeric: tabular-nums;
    }
    @media (pointer: coarse) {
      .speed button {
        min-height: 44px;
      }
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
    .player > :is(.offer, p) {
      justify-self: start;
      margin: 0;
    }
  `,
})
export class EpisodePlayer {
  readonly item = input.required<ItemRecord>();
  protected readonly items = inject(ItemsService);
  protected readonly player = inject(PlayerService);
  private readonly downloads = inject(DownloadsService);

  protected readonly isCurrent = computed(() => this.player.current() === this.item().id);
  protected readonly playing = computed(() => this.isCurrent() && this.player.playing());
  protected readonly position = computed(() => {
    if (this.isCurrent()) return this.player.position();
    const it = this.item();
    return it.played ? 0 : (it.position ?? 0);
  });
  protected readonly duration = computed(() =>
    this.isCurrent() ? this.player.duration() : (this.item().enclosure?.seconds ?? 0),
  );
  protected readonly rateText = computed(() => `${this.player.rate()}×`);
  /** The episode's download, once it is kept on the device (#180). */
  protected readonly downloaded = computed(() => this.downloads.record(this.item().id));
  /** How its download is going, while it is under way. */
  protected readonly progress = computed(() => this.downloads.progress()[this.item().id]);
  protected readonly sizeOf = size;
  /** Where the slider is being dragged to, so play does not pull it back mid-drag. */
  protected readonly scrub = signal<number | undefined>(undefined);
  protected readonly shownAt = computed(() => this.scrub() ?? this.position());
  /** How far along the slider is, for its track's played part. */
  protected readonly shownPercent = computed(() => {
    const total = this.duration();
    return total > 0 ? Math.min(100, Math.max(0, (this.shownAt() / total) * 100)) : 0;
  });

  protected progressText(p: { received: number; total?: number }): string {
    return p.total ? `${Math.floor((p.received / p.total) * 100)}%` : size(p.received);
  }

  protected toggle(it: ItemRecord): void {
    if (this.isCurrent()) this.player.toggle();
    else this.player.load(it, { autoplay: true });
  }

  protected seekTo(it: ItemRecord, event: Event): void {
    const to = Number((event.target as HTMLInputElement).value);
    this.scrub.set(undefined);
    if (!this.isCurrent()) this.player.load(it, { autoplay: false });
    this.player.seek(to);
  }

  protected skip(it: ItemRecord, by: -15 | 30): void {
    if (!this.isCurrent()) this.player.load(it, { autoplay: false });
    this.player.skip(by);
  }
}
