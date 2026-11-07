import { Location } from '@angular/common';
import { Component, HostListener, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { CaughtUp } from './caught-up';
import { shelfFromParam, shelfLink, shelfTitle } from './reader-list';
import { ReaderService } from './reader.service';
import { Swipe } from './swipe';

/**
 * The end of a shelf (Eric, 2026-11-07): where a swipe left from its
 * last article lands (`/reader/done?in=<shelf>`). Back is the shelf's
 * list; a swipe right, or k, goes back to the last article, and there
 * is nothing further left.
 */
@Component({
  selector: 'app-reader-done',
  imports: [RouterLink, Swipe, CaughtUp],
  template: `
    <main class="page" appSwipe [canLeft]="false" (right)="back()">
      <a [routerLink]="backLink()" class="back">Back</a>
      <app-reader-caught-up [shelf]="title()" />
    </main>
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
