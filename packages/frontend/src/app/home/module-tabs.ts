import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** One of a module's top tabs (#220). */
export interface ModuleTab {
  name: string;
  link: string | string[];
  /** A count drawn in the mono font after the name, such as what is unread. */
  count?: number;
  /** What the count counts, for the screen reader ("to buy", "unread"). */
  counts?: string;
  /**
   * `page` on the tab whose screen this is; `true` where the screen is
   * one the tab leads to, such as a folder's shelf under Folders.
   */
  current?: 'page' | 'true';
}

/**
 * A module's top tabs (#220, step 3 of #216): a segmented bar under its
 * header that swaps its screens in place. Each tab is a link to its own
 * URL, so Back steps between them and a tab can be linked.
 */
@Component({
  selector: 'app-module-tabs',
  imports: [RouterLink],
  template: `
    <nav [attr.aria-label]="label()">
      @for (t of tabs(); track t.name) {
        <a [routerLink]="t.link" [attr.aria-current]="t.current ?? null"
          >{{ t.name }}
          @if (t.count !== undefined) {
            <span class="count">{{ t.count }}</span>
            @if (t.counts) {
              <span class="visually-hidden">{{ ' ' + t.counts }}</span>
            }
          }
        </a>
      }
    </nav>
  `,
  styles: `
    :host {
      display: block;
    }
    nav {
      display: flex;
      gap: 4px;
      padding: 4px;
      background: var(--chip-bg);
      border-radius: var(--radius-card);
    }
    a {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      min-height: 36px;
      padding: 4px;
      border-radius: var(--radius-control);
      font-size: 14px;
      color: var(--quiet);
      text-align: center;
      text-decoration: none;
    }
    a[aria-current] {
      font-weight: 600;
      color: var(--ink);
      background: var(--surface);
      box-shadow: 0 1px 0 var(--rule);
    }
    .count {
      font-family: var(--font-mono);
      font-size: 12px;
    }
  `,
})
export class ModuleTabs {
  readonly label = input.required<string>();
  readonly tabs = input.required<readonly ModuleTab[]>();
}
