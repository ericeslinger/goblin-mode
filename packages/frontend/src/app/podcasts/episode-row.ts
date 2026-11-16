import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '../home/icon';
import { DownloadsService } from '../reader/downloads.service';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { PlayerService } from '../reader/player.service';
import { EpisodeArt } from './episode-art';
import { episodeState, lengthText, stateText } from './episodes';
import { QueueButton } from './queue-button';

/**
 * An episode's row (#290, step 6 of the layout pass), in Latest and on
 * a show's page: the artwork is Play (Pause while it plays), a glyph
 * on its corner saying so; the title, at most two lines, and the meta
 * line (state, the show where asked, age and length, downloaded) open
 * the episode; one trailing button adds it to the queue. The age and
 * the length are one unbreakable piece, so the length never takes a
 * line of its own. With no audio the artwork is only a picture and
 * there is no queue button.
 */
@Component({
  selector: 'li[appEpisodeRow]',
  imports: [EpisodeArt, Icon, QueueButton, RouterLink],
  template: `
    @let ep = item();
    @if (ep.enclosure) {
      <button type="button" class="art" [attr.aria-label]="playName()" (click)="play()">
        <app-episode-art [item]="ep" [show]="show()" [size]="56" />
        <span class="glyph" aria-hidden="true"
          ><app-icon [name]="playing() ? 'pause-bars' : 'play'" [size]="14" [filled]="true"
        /></span>
      </button>
    } @else {
      <span class="art"><app-episode-art [item]="ep" [show]="show()" [size]="56" /></span>
    }
    <a class="open" [routerLink]="['/podcasts/e', ep.id]" [queryParams]="queryParams()">
      <span class="title">{{ ep.title }}</span>
      <span class="meta"
        ><span class="state" [class.fresh]="fresh()">{{ stateWords() }}</span>
        @if (showName()) {
          · <span class="part">{{ showName() }}</span>
        }
        ·
        <span class="part"
          >{{ items.age(ep.published) }}
          @if (length(); as l) {
            · {{ l }}
          }
        </span>
        @if (downloads.has(ep.id)) {
          · <span class="part">downloaded</span>
        }
      </span>
    </a>
    @if (ep.enclosure) {
      <app-queue-button [item]="ep" (said)="said.emit($event)" />
    }
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: 8px 0;
      border-bottom: 1px solid var(--rule);
    }
    .art {
      position: relative;
      flex: none;
      display: block;
      width: 56px;
      height: 56px;
      min-width: 56px;
      min-height: 56px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-control);
      background: none;
    }
    button.art {
      cursor: pointer;
    }
    /* Play's mark on the artwork's corner: on any picture, a disc of
       the page's surface with the glyph in ink. */
    .glyph {
      position: absolute;
      right: -4px;
      bottom: -4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      box-sizing: border-box;
      border: var(--border) solid var(--rule);
      border-radius: 50%;
      background: var(--surface);
    }
    .open {
      flex: 1;
      min-width: 0;
      display: grid;
      gap: 2px;
      padding: 2px 4px;
      color: var(--ink);
      text-decoration: none;
    }
    .title {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      overflow: hidden;
      font-weight: 600;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .meta {
      color: var(--quiet);
      font-size: 14px;
      line-height: 1.35;
    }
    .part {
      white-space: nowrap;
    }
    .state.fresh {
      color: var(--ink);
      font-weight: 600;
    }
  `,
})
export class EpisodeRow {
  readonly item = input.required<ItemRecord>();
  /** The show's name, for the artwork's initials. */
  readonly show = input.required<string>();
  /** Whether the meta line names the show (Latest), or not (the show's own page). */
  readonly named = input(true);
  /** What the episode's page goes back to (a show's page passes `{ show: id }`). */
  readonly queryParams = input<Record<string, string> | null>(null);
  /** What the queue button could not do (the queue is full), for the page's status line. */
  readonly said = output<string>();

  protected readonly items = inject(ItemsService);
  protected readonly downloads = inject(DownloadsService);
  private readonly player = inject(PlayerService);

  /** Whether this row's episode is the one playing. */
  protected readonly playing = computed(
    () => this.player.current() === this.item().id && this.player.playing(),
  );
  /** Play's name, as the row's Play button had it before #290: "Play Reduction firing". */
  protected readonly playName = computed(
    () => `${this.playing() ? 'Pause' : 'Play'} ${this.item().title}`,
  );
  protected readonly fresh = computed(() => episodeState(this.item()) === 'new');
  protected readonly stateWords = computed(() => stateText(this.item()));
  protected readonly showName = computed(() => (this.named() ? this.show() : ''));

  /**
   * The length: the time left once a place is kept or it is playing
   * ("22 min left"), else how long it is; nothing when unknown.
   */
  protected length(): string | undefined {
    return lengthText(this.item(), this.player, (s) => this.items.duration(s));
  }

  /** Play, or Pause the one playing, with the app's one player (#179). */
  protected play(): void {
    const ep = this.item();
    if (this.player.current() === ep.id) this.player.toggle();
    else this.player.load(ep, { autoplay: true });
  }
}
