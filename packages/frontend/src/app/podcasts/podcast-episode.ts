import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { HomeLink } from '../home/home-link';
import { Icon } from '../home/icon';
import { DownloadsService } from '../reader/downloads.service';
import { EpisodePlayer } from '../reader/episode-player';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { articleHtml } from '../reader/reader-article';
import { ReaderService } from '../reader/reader.service';
import { EpisodeArt } from './episode-art';
import { episodeState, stateText } from './episodes';

/**
 * An episode's page in Podcasts (#245, `/podcasts/e/<id>`): its artwork,
 * show, title and state, the player's full controls, Mark as heard (or
 * Mark as new), Download, File in the garden and the page, then the
 * show notes, the feed's text rendered as the Reader renders an
 * article's. Opening it marks the notes read (`read`) and nothing else:
 * the episode stays New until it is heard (Eric, 2026-11-10). Back goes
 * to Latest, or to the show's episodes when it was opened from them.
 */
@Component({
  selector: 'app-podcast-episode',
  imports: [EpisodeArt, EpisodePlayer, HomeLink, Icon, RouterLink],
  template: `
    <main class="page">
      <header class="top">
        <app-home-link />
        <a class="back" [routerLink]="back().link"
          ><app-icon name="chevron-left" [size]="18" />{{ back().name }}</a
        >
        <span class="spacer"></span>
        @if (item(); as it) {
          @if (it.enclosure && downloads.available()) {
            @if (downloads.record(it.id)) {
              <button
                type="button"
                class="icon"
                aria-label="Remove download"
                (click)="downloads.remove(it.id)"
              >
                <app-icon name="download" [size]="22" />
                <span class="dot" aria-hidden="true"></span>
              </button>
            } @else {
              <button
                type="button"
                class="icon"
                aria-label="Download"
                [disabled]="!!downloads.progress()[it.id]"
                (click)="download(it)"
              >
                <app-icon name="download" [size]="22" />
              </button>
            }
          }
          @if (it.noteId) {
            <a class="icon" [routerLink]="['/n', it.noteId]" aria-label="In the garden">
              <app-icon name="leaf" [size]="22" />
            </a>
          } @else {
            <button
              type="button"
              class="icon"
              aria-label="File in the garden"
              (click)="file(it.id)"
            >
              <app-icon name="leaf-plus" [size]="22" />
            </button>
          }
          @if (it.link) {
            <a
              class="icon"
              [href]="it.link"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open the page"
            >
              <app-icon name="open-page" [size]="22" />
            </a>
          }
        }
      </header>
      @if (item(); as it) {
        <article>
          <header class="head">
            <app-episode-art [item]="it" [show]="show()" [size]="88" />
            <div>
              <a class="show" [routerLink]="['/podcasts/s', it.feedId]">{{ show() }}</a>
              <h1>{{ it.title }}</h1>
              <p class="meta">
                @if (downloads.record(it.id)) {
                  Downloaded ·
                }
                <span class="state">{{ state(it) }}</span> · {{ items.age(it.published) }}
                @if (it.enclosure?.seconds; as s) {
                  · {{ items.duration(s) }}
                }
              </p>
            </div>
          </header>
          @if (it.enclosure) {
            <app-episode-player [item]="it" />
          }
          <p class="acts">
            @if (heard(it)) {
              <button type="button" (click)="items.setPlayed(it.id, false)">Mark as new</button>
            } @else {
              <button type="button" (click)="items.setPlayed(it.id, true)">Mark as heard</button>
            }
          </p>
          @if (said()) {
            <p class="status" role="status">{{ said() }}</p>
          }
          <section aria-labelledby="show-notes">
            <h2 id="show-notes">Show notes</h2>
            <p class="meta">From {{ show() }}'s feed, as it gave them.</p>
            <div class="body" [innerHTML]="html()" (click)="openLink($event)"></div>
          </section>
        </article>
      } @else if (items.loaded()) {
        <p class="muted">This episode is not on this device. Open it online, or go back.</p>
      }
    </main>
  `,
  styles: `
    .top {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .back {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 44px;
      min-width: 0;
      margin-left: var(--space-2);
      padding: 0 8px;
      color: var(--quiet);
      text-decoration: none;
      overflow-wrap: anywhere;
    }
    .spacer {
      flex: 1;
    }
    .icon {
      position: relative;
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-control);
      background: transparent;
      cursor: pointer;
    }
    .icon:disabled {
      opacity: 0.4;
      cursor: default;
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
    .head {
      display: flex;
      gap: var(--space-3);
      align-items: flex-start;
      margin-top: var(--space-2);
    }
    .show {
      color: var(--quiet);
      font-size: 14px;
    }
    h1 {
      margin: 4px 0;
      font-size: 22px;
      overflow-wrap: anywhere;
    }
    h2 {
      margin: var(--space-3) 0 0;
      font-size: 16px;
    }
    .meta,
    .muted,
    .status {
      color: var(--quiet);
      font-size: 14px;
    }
    .state {
      color: var(--ink);
      font-weight: 600;
    }
    .acts {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .acts button {
      min-height: 44px;
    }
    .body {
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    :host ::ng-deep .body img {
      max-width: 100%;
      height: auto;
    }
  `,
})
export class PodcastEpisode {
  protected readonly items = inject(ItemsService);
  protected readonly downloads = inject(DownloadsService);
  private readonly reader = inject(ReaderService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly route = inject(ActivatedRoute);
  private readonly id = toSignal(this.route.paramMap.pipe(map((p) => p.get('id') ?? '')), {
    initialValue: '',
  });
  /** The show it was opened from, when it was opened from one's episodes. */
  private readonly from = toSignal(
    this.route.queryParamMap.pipe(map((p) => p.get('show') ?? undefined)),
    { initialValue: undefined },
  );
  protected readonly item = computed(() => this.items.find(this.id()));
  protected readonly said = signal('');
  protected readonly show = computed(
    () => this.reader.feeds().find((f) => f.id === this.item()?.feedId)?.title ?? 'A show',
  );
  protected readonly back = computed(() => {
    const from = this.from();
    const feed = from ? this.reader.feeds().find((f) => f.id === from) : undefined;
    return feed
      ? { link: ['/podcasts/s', feed.id], name: feed.title }
      : { link: ['/podcasts'], name: 'Latest' };
  });
  protected readonly html = computed<SafeHtml>(() => {
    const it = this.item();
    // Sanitized by renderNoteHtml, as an article's is (#162).
    return this.sanitizer.bypassSecurityTrustHtml(
      articleHtml(it?.readerContent || it?.content || '', this.reader.images()),
    );
  });

  constructor() {
    // One no shelf holds (a show's older episode, a link) is fetched by its id.
    effect(() => {
      const id = this.id();
      if (id && this.items.loaded() && !this.item()) untracked(() => this.items.open(id));
    });
    // Opening it reads the notes, once, and nothing else (#245).
    let marked = '';
    effect(() => {
      const it = this.item();
      if (!it || it.read || marked === it.id) return;
      marked = it.id;
      untracked(() => this.items.setRead(it.id, true));
    });
  }

  protected state(it: ItemRecord): string {
    return stateText(it);
  }

  protected heard(it: ItemRecord): boolean {
    return episodeState(it) === 'heard';
  }

  /** Download (#180): kept on the device, or the reason it was not, said. */
  protected async download(it: ItemRecord): Promise<void> {
    this.said.set('');
    const why = await this.downloads.download(it);
    if (why) this.said.set(why);
  }

  /** File in the garden (#163): a clipping, made at once; its link shows in place. */
  protected file(id: string): void {
    const noteId = this.items.fileInGarden(id);
    this.said.set(noteId ? 'Filed in the garden.' : 'Could not file it; try again online.');
  }

  /** A link in the notes opens in a new tab, never over the app. */
  protected openLink(event: MouseEvent): void {
    const a = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    event.preventDefault();
    if ((a.getAttribute('href') ?? '').startsWith('#')) return;
    window.open(a.href, '_blank', 'noopener');
  }
}
