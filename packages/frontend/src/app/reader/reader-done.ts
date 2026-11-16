import { Location } from '@angular/common';
import { Component, HostListener, booleanAttribute, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { PageHeader } from '../home/page-header';
import { CaughtUp } from './caught-up';
import { shelfFromParam, shelfLink, shelfTitle } from './reader-list';
import { ReaderService } from './reader.service';
import { Swipe } from './swipe';

/**
 * The end of a shelf (Eric, 2026-11-07): where a swipe left from its
 * last article lands (`/reader/done?in=<shelf>`). Its header goes
 * back to the shelf's list, "‹ Design" (#286); a swipe right, or k,
 * goes back to the last article, and there is nothing further left.
 * In the Reader's three panes (#289, 2026-11-16) it is the article
 * pane's, under the Reader's header: no header or swipe of its own,
 * its heading an h2, and k and Escape as here.
 */
@Component({
  selector: 'app-reader-done',
  imports: [PageHeader, Swipe, CaughtUp],
  template: `
    @if (pane()) {
      <app-reader-caught-up [shelf]="title()" [level]="2" />
    } @else {
      <main class="page" appSwipe [canLeft]="false" (right)="back()">
        <app-page-header [backLabel]="title()" [backLink]="backLink()" />
        <app-reader-caught-up [shelf]="title()" />
      </main>
    }
  `,
  styles: `
    :host {
      display: block;
      overflow-x: clip;
    }
    main {
      touch-action: pan-y;
    }
    main.settling {
      transition: transform 180ms ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      main.settling {
        transition: none;
      }
    }
  `,
})
export class ReaderDone {
  /** Drawn in the article pane of the three panes (#289). */
  readonly pane = input(false, { transform: booleanAttribute });
  private readonly reader = inject(ReaderService);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly shelf = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((p) => shelfFromParam(p.get('in')))),
    { initialValue: shelfFromParam(null) },
  );
  protected readonly backLink = computed(() => shelfLink(this.shelf()));
  protected readonly title = computed(() => shelfTitle(this.shelf(), this.reader.feeds()));

  /**
   * Back to the article this came from; opened from anywhere else (a
   * link, a reload), there is no such article in the history, so the
   * shelf's list.
   */
  protected back(): void {
    if (this.router.lastSuccessfulNavigation()?.previousNavigation) this.location.back();
    else void this.router.navigate(this.backLink());
  }

  @HostListener('document:keydown', ['$event'])
  protected keys(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case 'k':
        this.back();
        break;
      case 'Escape':
        void this.router.navigate(this.backLink());
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
