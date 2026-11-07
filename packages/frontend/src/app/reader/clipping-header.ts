import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { hostOf } from '@mossgoblin/schema';
import type { NoteRecord } from '../notes/notes.service';

/**
 * Above a clipping's text (#163): where it was clipped from, with the
 * page to open, and the Reader article it came from. The text below is
 * a page's words, kept as the fetcher stored them.
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
        @if (note().source?.feedItemId) {
          <a [routerLink]="['/reader/a', note().source!.feedItemId]">In the Reader</a>
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
  protected readonly host = computed(() => hostOf(this.note().source?.url ?? ''));
}
