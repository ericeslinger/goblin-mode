import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';

/** Reloads the page; a seam for specs. */
export const reloadPage = { run: () => location.reload() };

/**
 * A path this app version has no route for. The service worker may be
 * serving an older cached version than the one deployed (a link to a new
 * page, such as the Claude consent page, arrives before the update), so
 * first look for a newer version and reload into it; only then go home.
 */
@Component({
  selector: 'app-unknown-route',
  template: `<p class="page muted" role="status">Looking under the moss…</p>`,
})
export class UnknownRoute {
  private readonly router = inject(Router);
  private readonly updates = inject(SwUpdate, { optional: true });

  constructor() {
    void this.resolve();
  }

  private async resolve(): Promise<void> {
    try {
      if (this.updates?.isEnabled && (await this.updates.checkForUpdate())) {
        await this.updates.activateUpdate();
        reloadPage.run();
        return;
      }
    } catch (err) {
      console.error('update check', err);
    }
    void this.router.navigate([''], { replaceUrl: true });
  }
}
