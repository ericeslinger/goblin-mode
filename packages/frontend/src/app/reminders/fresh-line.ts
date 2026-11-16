import { Component, Injectable, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ModulesService } from '../modules/modules.service';
import { PodcastsSeen } from '../podcasts/podcasts-seen';
import { ItemsService } from '../reader/items.service';

/**
 * What came into the Reader and Podcasts since the gardener last looked
 * (#173, #251), as Right Now counts it: the Reader's unread articles
 * newer than their folder's list was last opened, and the New episodes
 * newer than the last visit to Latest. Zero for a module that is off.
 */
@Injectable({ providedIn: 'root' })
export class FreshCounts {
  private readonly modules = inject(ModulesService);
  private readonly items = inject(ItemsService);
  private readonly seen = inject(PodcastsSeen);

  /**
   * Summed over the folders, an article whose feed is in two folders
   * counts in each; never more than the unread, so this line and the
   * Reader's "N unread" cannot read as a disagreement (#288).
   */
  readonly reader = computed(() => {
    if (!this.modules.reader()) return 0;
    const sum = this.items.newSince().reduce((total, f) => total + f.count, 0);
    return Math.min(sum, this.items.unreadCounts()['all'] ?? 0);
  });
  readonly podcasts = computed(() => (this.modules.podcasts() ? this.seen.fresh() : 0));
}

/** The parts of the foot line, a zero part left out (#288). */
export function freshParts(
  reader: number,
  podcasts: number,
): { name: string; count: number; link: string }[] {
  return [
    ...(reader ? [{ name: 'Reader', count: reader, link: '/reader' }] : []),
    ...(podcasts ? [{ name: 'Podcasts', count: podcasts, link: '/podcasts' }] : []),
  ];
}

/**
 * What is new, said as Home's Right Now row says it (#288): "since you
 * last looked", so it never reads as the Reader tile's unread.
 */
export function sinceLooked(reader: number, podcasts: number): string {
  if (reader && podcasts) {
    return `${reader} new in the Reader, ${podcasts} in Podcasts, since you last looked`;
  }
  if (reader) return `${reader} new in the Reader since you last looked`;
  if (podcasts) return `${podcasts} new in Podcasts since you last looked`;
  return '';
}

/**
 * Right Now's foot line in the panel and the sheet (#288): one quiet
 * line, "New since you last looked: Reader 107 · Podcasts 3", each part
 * a link to its module, under the reminders. Nothing when nothing is new.
 * The full Right Now screen keeps a line per folder instead.
 */
@Component({
  selector: 'app-fresh-line',
  imports: [RouterLink],
  template: `
    @if (parts().length) {
      <p class="fresh">
        New since you last looked:
        @for (p of parts(); track p.name; let last = $last) {
          <a class="touch-target" [routerLink]="p.link">{{ p.name }} {{ p.count }}</a>
          @if (!last) {
            <span aria-hidden="true"> · </span>
          }
        }
      </p>
    }
  `,
  styles: `
    .fresh {
      margin: 8px 0 0;
      font-size: 14px;
      color: var(--quiet);
    }
    a {
      display: inline-block;
      color: var(--quiet);
      text-decoration: underline;
    }
    /* Clear of the link above's 44 px tap area (2026-11-15). */
    @media (pointer: coarse) {
      .fresh {
        margin-top: 22px;
      }
    }
  `,
})
export class FreshLine {
  private readonly fresh = inject(FreshCounts);
  protected readonly parts = computed(() => freshParts(this.fresh.reader(), this.fresh.podcasts()));
}
