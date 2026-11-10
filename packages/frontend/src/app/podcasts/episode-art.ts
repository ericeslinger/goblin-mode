import { Component, computed, inject, input } from '@angular/core';
import type { ItemRecord } from '../reader/items.service';
import { ReaderService } from '../reader/reader.service';
import { initials, tint } from './episodes';

/**
 * An episode's artwork (#245): its own image, when it has one and
 * images are on, else its show's initials on a square tinted with the
 * theme's second colour. Decoration: the row names the episode.
 */
@Component({
  selector: 'app-episode-art',
  template: `
    @if (src(); as url) {
      <img
        [src]="url"
        alt=""
        [attr.width]="size()"
        [attr.height]="size()"
        loading="lazy"
        referrerpolicy="no-referrer"
      />
    } @else {
      <span
        class="square"
        aria-hidden="true"
        [style.width.px]="size()"
        [style.height.px]="size()"
        [style.font-size.px]="size() * 0.36"
        [style.background]="background()"
        >{{ letters() }}</span
      >
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
    img,
    .square {
      display: block;
      box-sizing: border-box;
      border-radius: var(--radius-control);
      object-fit: cover;
    }
    .square {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--ink);
      font-family: var(--font-mono);
      font-weight: 600;
      border: var(--border) solid var(--rule);
    }
  `,
})
export class EpisodeArt {
  readonly item = input.required<Pick<ItemRecord, 'feedId' | 'image'>>();
  /** The show's name, for its initials. */
  readonly show = input.required<string>();
  readonly size = input(48);
  private readonly reader = inject(ReaderService);
  protected readonly src = computed(() => (this.reader.images() ? this.item().image : undefined));
  protected readonly letters = computed(() => initials(this.show()));
  protected readonly background = computed(
    () => `color-mix(in srgb, var(--second) ${tint(this.item().feedId)}%, var(--surface))`,
  );
}
