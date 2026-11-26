import { DOCUMENT } from '@angular/common';
import { Component, inject } from '@angular/core';

/** Leaves the app for a URL; a seam for specs. */
export const leaveFor = { run: (url: string) => location.replace(url) };

/**
 * `/s/<id>`, a note's public copy (2026-11-26), is the Worker's page,
 * never the app's. This version's service worker leaves it to the
 * network (ngsw-config.json), but a copy of an older one installed on
 * this device answers every path with the app: here the app hands the
 * address back to the network, past the service worker
 * (`ngsw-bypass`). Asked once: if the app answers again (a server with
 * no Worker, as `ng serve`), it says so rather than go round.
 */
@Component({
  selector: 'app-public-page-route',
  template: `<p class="page muted" role="status">
    @if (again) {
      This is a shared link. It opens on the app's own site, not here.
    } @else {
      Opening the shared copy…
    }
  </p>`,
})
export class PublicPageRoute {
  protected readonly again: boolean;

  constructor() {
    const url = new URL(inject(DOCUMENT).defaultView?.location.href ?? 'http://x/');
    this.again = url.searchParams.has('ngsw-bypass');
    if (!this.again) leaveFor.run(`${url.pathname}?ngsw-bypass=1`);
  }
}
