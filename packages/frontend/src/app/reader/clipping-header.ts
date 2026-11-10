import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { hostOf } from '@mossgoblin/schema';
import type { NoteRecord } from '../notes/notes.service';
import { ReaderService } from './reader.service';

/**
 * The feed an item's id was derived from (#251): `feedItemId` is the
 * feed's id, `f-` and sixteen hex digits, then a dash and the guid's
 * hash. Undefined for any other shape.
 */
export function feedOfItem(itemId: string): string | undefined {
  return /^(f-[0-9a-f]{16})-[0-9a-f]{16}$/.exec(itemId)?.[1];
}

/**
 * Above a clipping's text (#163): where it was clipped from, with the
 * page to open, and the Reader article it came from, or the episode's
 * page in Podcasts when its feed is a show there (#251: "In Podcasts").
 * The text below is a page's words, kept as the fetcher stored them.
 */
@Component({
  selector: 'app-clipping-header',
  imports: [RouterLink],
  template: `
    <section class="clipping" aria-label="Clipping">
      <p class="meta">
        Clipped from {{ host() || 'a feed' }}.
        @if (note().source?.url) {
          <a [href]="note().source!.url" target="_blank" rel="noopener noreferrer">Open the page</a>
        }
        @if (back(); as b) {
          <a [routerLink]="b.link">{{ b.words }}</a>
        }
      </p>
    </section>
  `,
  styles: `
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin: 0 0 var(--space-2);
      color: var(--quiet);
      font-size: 14px;
    }
  `,
})
export class ClippingHeader {
  readonly note = input.required<NoteRecord>();
  private readonly reader = inject(ReaderService);
  protected readonly host = computed(() => hostOf(this.note().source?.url ?? ''));
  /** The way back to the item: the episode's page for a show in Podcasts, else the article's. */
  protected readonly back = computed(() => {
    const id = this.note().source?.feedItemId;
    if (!id) return undefined;
    const feed = feedOfItem(id);
    return feed && this.reader.isPodcast(feed)
      ? { link: ['/podcasts/e', id], words: 'In Podcasts' }
      : { link: ['/reader/a', id], words: 'In the Reader' };
  });
}
