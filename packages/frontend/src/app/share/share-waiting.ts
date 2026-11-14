import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';
import { ShareStore } from './share-store';

/**
 * A share kept on this device and not filed yet (2026-11-14): signed
 * out when it came, offline for a recipe import, or left. One line, on
 * the launch screen and Home, back to it.
 */
@Component({
  selector: 'app-share-waiting',
  imports: [RouterLink],
  template: `
    @if (waiting().length; as n) {
      <p>
        <a routerLink="/share">{{
          n === 1 ? 'A share is waiting to be filed' : n + ' shares are waiting to be filed'
        }}</a>
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    :host(:empty) {
      display: none;
    }
    p {
      margin: 0;
    }
    a {
      color: var(--accent);
    }
  `,
})
export class ShareWaiting {
  private readonly store = inject(ShareStore);
  private readonly auth = inject(AuthService);
  /** Only the shares the one signed in may see (review on #271). */
  protected readonly waiting = computed(() => this.store.visibleTo(this.auth.user()?.uid));
}
