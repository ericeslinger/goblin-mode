import { Component, type ElementRef, input, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HomeLink } from './home-link';
import { Icon } from './icon';

/**
 * One page header (#286, 2026-11-15), the Reader's made shared: the
 * leaf (with New note beside it), a way back to the screen's parent
 * when it has one ("‹ Reader", named "Back to Reader"), the screen's
 * title as its one h1, and up to three icon actions projected at the
 * right. It scrolls with the page, as the Reader's did. The title
 * wraps and the back link's name truncates, so at 320 px nothing
 * pushes the actions off the screen.
 *
 * The note bar is not this: it is the note's own (DESIGN.md, Top bar),
 * and its Back turns the note over.
 */
@Component({
  selector: 'app-page-header',
  imports: [HomeLink, Icon, RouterLink],
  template: `
    <header>
      <app-home-link />
      @if (backLabel(); as label) {
        <a class="back" [routerLink]="backLink()" [attr.aria-label]="'Back to ' + label"
          ><app-icon name="chevron-left" [size]="18" /><span class="label">{{ label }}</span></a
        >
      }
      @if (title(); as t) {
        <!-- Focusable from code (a share's arrival), never by Tab. -->
        <h1 #heading tabindex="-1">{{ t }}</h1>
      } @else {
        <span class="spacer"></span>
      }
      <span class="actions"><ng-content /></span>
    </header>
  `,
  styles: `
    :host {
      display: block;
      margin-bottom: var(--space-2);
    }
    header {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
    }
    app-home-link {
      flex: none;
      margin-right: var(--space-2);
    }
    .back {
      display: inline-flex;
      flex: 0 1 auto;
      align-items: center;
      gap: 4px;
      min-width: 0;
      max-width: 40%;
      min-height: 44px;
      padding: 0 8px 0 0;
      border-radius: var(--radius-control);
      color: var(--quiet);
      text-decoration: none;
    }
    .back app-icon {
      flex: none;
    }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    h1,
    .spacer {
      flex: 1;
      min-width: 0;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      flex: none;
      align-items: center;
      gap: 2px;
    }
    .actions:empty {
      display: none;
    }
  `,
})
export class PageHeader {
  /** The screen's name, its one h1; left out where the h1 is the content's own. */
  readonly title = input<string>();
  /** The parent screen's name, for "‹ Label"; no back link without it. */
  readonly backLabel = input<string>();
  /** Router commands to the parent screen. */
  readonly backLink = input<string | readonly unknown[]>([]);

  /** The h1, for a screen that moves focus to it on arrival. */
  readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
}
