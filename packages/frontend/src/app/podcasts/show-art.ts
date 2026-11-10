import { Component, computed, inject, input, signal } from '@angular/core';
import { ReaderService } from '../reader/reader.service';
import { initials, tint } from './episodes';

/**
 * A show's square (#246): its artwork (the feed's own image, else its
 * newest episode's) in a fixed square box, loaded lazily, or, with
 * none, with images off, or when the image fails to load, a square
 * tinted with the theme's second colour by the show's id with its
 * initials, or its name when `named`. Decoration: `alt=""`, since the
 * link or the row around it names the show.
 */
@Component({
  selector: 'app-show-art',
  template: `
    @if (shown(); as url) {
      <img
        [src]="url"
        alt=""
        [attr.width]="size() ?? null"
        [attr.height]="size() ?? null"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
        (error)="failed.set(url)"
      />
    } @else {
      <span
        class="square"
        [class.named]="named()"
        aria-hidden="true"
        [style.font-size.px]="named() ? null : (size() ?? 48) * 0.36"
        [style.background]="background()"
        >{{ named() ? title() : letters() }}</span
      >
    }
  `,
  styles: `
    :host {
      display: block;
      flex: none;
      aspect-ratio: 1;
      overflow: hidden;
      border-radius: var(--radius-control);
    }
    :host([data-fill]) {
      width: 100%;
    }
    img,
    .square {
      display: block;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      border-radius: inherit;
      object-fit: cover;
    }
    .square {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--ink);
      font-family: var(--font-mono);
      font-weight: 600;
      border: var(--border) solid var(--rule);
    }
    .square.named {
      align-items: flex-end;
      justify-content: flex-start;
      padding: 8px;
      font-family: inherit;
      font-size: 15px;
      line-height: 1.15;
      overflow-wrap: anywhere;
    }
  `,
  host: {
    '[style.width.px]': 'size() ?? null',
    '[style.height.px]': 'size() ?? null',
    '[attr.data-fill]': "size() === undefined ? '' : null",
  },
})
export class ShowArt {
  /** The show's id, for its tint. */
  readonly id = input.required<string>();
  /** The show's name, for its initials or drawn on the square. */
  readonly title = input.required<string>();
  /** Its artwork, when it has one. */
  readonly src = input<string | undefined>(undefined);
  /** Pixels a side; none fills the width it is given. */
  readonly size = input<number | undefined>(undefined);
  /** Draws the show's name on the fallback square, not its initials. */
  readonly named = input(false);
  private readonly reader = inject(ReaderService);
  /** The link that failed to load, so the square stands in for it. */
  protected readonly failed = signal<string | undefined>(undefined);
  protected readonly shown = computed(() => {
    const src = this.reader.images() ? this.src() : undefined;
    return src && src !== this.failed() ? src : undefined;
  });
  protected readonly letters = computed(() => initials(this.title()));
  protected readonly background = computed(
    () => `color-mix(in srgb, var(--second) ${tint(this.id())}%, var(--surface))`,
  );
}
