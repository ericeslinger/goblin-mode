import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ModulesService } from '../modules/modules.service';
import { PodcastsSeen } from './podcasts-seen';

/**
 * What is new in Podcasts, for Right Now (#251), beside the Reader's
 * lines (#173): "3 new in Podcasts", to Latest, while the module is on
 * and any New episode came out since the last visit to Latest on this
 * device. Counted from the episodes at hand; no server work.
 */
@Component({
  selector: 'app-podcasts-new',
  imports: [RouterLink],
  template: `
    @if (modules.podcasts() && seen.fresh(); as n) {
      <p class="podcasts-new">
        <a routerLink="/podcasts">{{ n }} new in Podcasts</a>
      </p>
    }
  `,
  styles: `
    p {
      margin: 8px 0 0;
    }
    a {
      color: var(--accent);
    }
  `,
})
export class PodcastsNew {
  protected readonly modules = inject(ModulesService);
  protected readonly seen = inject(PodcastsSeen);
}
