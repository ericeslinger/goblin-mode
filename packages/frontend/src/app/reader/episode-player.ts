import { Component, computed, inject, input, signal } from '@angular/core';
import { DownloadsService, size } from './downloads.service';
import { type ItemRecord, ItemsService } from './items.service';
import { PlayerService } from './player.service';

/**
 * An episode's full controls (#179), on its page: a big play or pause,
 * the Position slider, elapsed of total, back 15, on 30 and the speed,
 * Continue from another device's newer place, and how its download
 * stands (#180). The Reader's article and Podcasts' episode page (#245)
 * both hold it; the player's state once the episode is in hand, the
 * kept place until then.
 */
@Component({
  selector: 'app-episode-player',
  template: `
    @let it = item();
    <section class="player" aria-label="Player" data-no-swipe>
      <button
        type="button"
        class="main"
        [attr.aria-label]="playing() ? 'Pause' : 'Play'"
        (click)="toggle(it)"
      >
        {{ playing() ? '❚❚ Pause' : '▶ Play' }}
      </button>
      <input
        type="range"
        aria-label="Position"
        min="0"
        step="1"
        [max]="duration()"
        [value]="shownAt()"
        [attr.aria-valuetext]="items.clock(shownAt()) + ' of ' + items.clock(duration())"
        (input)="scrub.set(+$any($event.target).value)"
        (change)="seekTo(it, $event)"
      />
      <span class="time">{{ items.clock(shownAt()) }} / {{ items.clock(duration()) }}</span>
      <span class="skips">
        <button type="button" aria-label="Back 15 seconds" (click)="skip(it, -15)">−15</button>
        <button type="button" aria-label="Forward 30 seconds" (click)="skip(it, 30)">+30</button>
        <button type="button" [attr.aria-label]="'Speed ' + rateText()" (click)="player.nextRate()">
          {{ rateText() }}
        </button>
      </span>
      @if (isCurrent() && player.offer(); as at) {
        <button type="button" (click)="player.takeOffer()">
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
      grid-template-columns: auto 1fr;
      gap: var(--space-2) var(--space-3);
      align-items: center;
      margin: var(--space-3) 0;
      padding: var(--space-3);
      background: var(--surface);
      border: 1px solid var(--rule);
      border-radius: var(--radius-control);
    }
    .main {
      grid-row: span 2;
      min-width: 88px;
      min-height: 56px;
      font-size: 18px;
    }
    input {
      width: 100%;
    }
    .time,
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
    .time {
      font-variant-numeric: tabular-nums;
    }
    .skips {
      grid-column: 1 / -1;
      display: flex;
      gap: var(--space-2);
    }
    .skips button {
      min-width: 48px;
      min-height: 40px;
    }
    .player > :is(button:not(.main), p) {
      grid-column: 1 / -1;
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
