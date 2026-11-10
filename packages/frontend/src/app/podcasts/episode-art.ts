import { Component, computed, inject, input, signal } from '@angular/core';
import type { ItemRecord } from '../reader/items.service';
import { ReaderService } from '../reader/reader.service';
import { initials, tint } from './episodes';

/**
 * An episode's artwork (#245): its own image, else its show's (#246),
 * when images are on, else its show's initials on a square tinted with
 * the theme's second colour, which also stands in when the image fails
 * to load (#246). Decoration: the row names the episode.
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
        (error)="failed.set(url)"
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
  /** The link that failed to load, so the square stands in for it. */
  protected readonly failed = signal<string | undefined>(undefined);
  protected readonly src = computed(() => {
    if (!this.reader.images()) return undefined;
    const item = this.item();
    const src = item.image ?? this.reader.feeds().find((f) => f.id === item.feedId)?.image;
    return src && src !== this.failed() ? src : undefined;
  });
  protected readonly letters = computed(() => initials(this.show()));
  protected readonly background = computed(
    () => `color-mix(in srgb, var(--second) ${tint(this.item().feedId)}%, var(--surface))`,
  );
}
