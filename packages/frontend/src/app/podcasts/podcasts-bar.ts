import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HomeLink } from '../home/home-link';
import { Icon } from '../home/icon';
import { type ModuleTab, ModuleTabs } from '../home/module-tabs';
import { ModulesService } from '../modules/modules.service';
import { DownloadsService } from '../reader/downloads.service';
import { ItemsService } from '../reader/items.service';
import { ReaderService } from '../reader/reader.service';
import { episodeState } from './episodes';

export type PodcastsTab = 'latest' | 'shows';

/**
 * Podcasts' header and tabs (#245, step 1 of #244): the leaf, then
 * Downloads (with a dot while anything is downloaded) and Add a podcast
 * as icons with names; under them the tabs Latest (`/podcasts`, with
 * how many are new) and Shows (`/podcasts/shows`). Queue comes with
 * step 3, so it has no tab yet.
 */
@Component({
  selector: 'app-podcasts-bar',
  imports: [HomeLink, Icon, ModuleTabs, RouterLink],
  template: `
    <header>
      <app-home-link />
      <h1>Podcasts</h1>
      <a class="icon" routerLink="/reader/downloads" aria-label="Downloads">
        <app-icon name="download" [size]="22" />
        @if (downloads.list().length) {
          <span class="dot" aria-hidden="true"></span>
        }
      </a>
      <a class="icon" routerLink="/podcasts/add" aria-label="Add a podcast">
        <app-icon name="plus" [size]="22" />
      </a>
    </header>
    <app-module-tabs label="Podcasts screens" [tabs]="tabs()" />
    @if (!modules.podcasts()) {
      <p class="muted">
        Podcasts is off. Turn it on in <a routerLink="/settings">Settings</a>, Modules.
      </p>
    } @else if (reader.loaded() && reader.podcastFeeds().length === 0) {
      <p class="muted">
        No shows yet. <a routerLink="/podcasts/add">Add a podcast</a> by its feed or its site.
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    header {
      display: flex;
      align-items: center;
      gap: 2px;
      margin-bottom: var(--space-2);
    }
    app-home-link {
      margin-right: var(--space-2);
    }
    h1 {
      flex: 1;
      margin: 0;
      font-size: 20px;
    }
    .icon {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border-radius: var(--radius-control);
    }
    .dot {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--second);
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
  `,
})
export class PodcastsBar {
  /** The tab this screen is, or leads from. */
  readonly active = input.required<PodcastsTab>();
  /** `page` on the tab's own screen; `true` on one it leads to, such as a show's episodes. */
  readonly current = input<'page' | 'true'>('page');

  protected readonly modules = inject(ModulesService);
  protected readonly reader = inject(ReaderService);
  protected readonly downloads = inject(DownloadsService);
  private readonly items = inject(ItemsService);

  protected readonly tabs = computed<ModuleTab[]>(() => {
    const at = (tab: PodcastsTab) => (this.active() === tab ? this.current() : undefined);
    const fresh = this.items.episodes().filter((e) => episodeState(e) === 'new').length;
    return [
      { name: 'Latest', link: '/podcasts', count: fresh, counts: 'new', current: at('latest') },
      { name: 'Shows', link: '/podcasts/shows', current: at('shows') },
    ];
  });
}
