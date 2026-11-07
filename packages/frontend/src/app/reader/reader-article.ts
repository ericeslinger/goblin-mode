import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { renderNoteHtml } from '@mossgoblin/editor';
import { map } from 'rxjs';
import { DownloadsService, size } from './downloads.service';
import { type ItemRecord, ItemsService } from './items.service';
import { CaughtUp } from './caught-up';
import { PlayerService } from './player.service';
import { shelfFromParam, shelfLink, shelfParam, shelfTitle } from './reader-list';
import { ReaderService } from './reader.service';
import { Swipe } from './swipe';

/**
 * The article's HTML for the page (#162): the stored markdown rendered
 * as a note is (`renderNoteHtml`, sanitized, http and https sources
 * only), images lazy and sent with no referrer, or replaced by their
 * words when the gardener has images off.
 */
export function articleHtml(markdown: string, images: boolean): string {
  const html = renderNoteHtml(markdown);
  return images
    ? html.replace(/<img\b/g, '<img loading="lazy" referrerpolicy="no-referrer"')
    : html.replace(/<img\b[^>]*?(?:\salt="([^"]*)")?[^>]*>/g, (_, alt: string | undefined) =>
        alt ? `<span class="no-image">[${alt}]</span>` : '',
      );
}

/**
 * One article (#162): rendered as notes are, with Open the page, Keep
 * unread, Save, and next and previous by swipe (left for next) or j and
 * k. Opening marks it read; links inside open in a new tab. Next from
 * the shelf's last article is the caught-up page (Eric, 2026-11-07).
 * An episode (#179) has the player's full controls above its notes,
 * and opening it reads nothing: hearing it to the end does. Its
 * Download keeps it on the device to play offline, with its progress,
 * then Remove (#180).
 */
@Component({
  selector: 'app-reader-article',
  imports: [RouterLink, Swipe, CaughtUp],
  template: `
    <main
      class="page"
      appSwipe
      #main
      [canLeft]="!!next() || atEnd()"
      [canRight]="!!prev()"
      (left)="go(1)"
      (right)="go(-1)"
    >
      @if (dragging()) {
        <!-- The stories either side, drawn beside this one while it is dragged, from the top
             of the screen however far down this one is read (Eric, 2026-11-07). -->
        @if (prev(); as p) {
          <article class="pane prev" aria-hidden="true" [style.top.px]="paneTop()">
            <h1>{{ p.title }}</h1>
            <p class="meta">{{ sourceOf(p) }} · {{ when(p) }}</p>
            <div class="body" [innerHTML]="prevHtml()"></div>
          </article>
        }
        @if (next(); as n) {
          <article class="pane next" aria-hidden="true" [style.top.px]="paneTop()">
            <h1>{{ n.title }}</h1>
            <p class="meta">{{ sourceOf(n) }} · {{ when(n) }}</p>
            <div class="body" [innerHTML]="nextHtml()"></div>
          </article>
        } @else if (atEnd()) {
          <div class="pane next" aria-hidden="true" [style.top.px]="paneTop()">
            <app-reader-caught-up [shelf]="shelfTitle()" />
          </div>
        }
      }
      <a [routerLink]="backLink()" class="back">Back</a>
      @if (pendingDone()) {
        <!-- The caught-up page, shown here while its route loads. -->
        <app-reader-caught-up [shelf]="shelfTitle()" />
      } @else if (item(); as it) {
        <article>
          <header>
            <h1>{{ it.title }}</h1>
            <p class="meta">
              @if (downloaded()) {
                Downloaded ·
              }
              {{ source() }}
              @if (it.author) {
                , {{ it.author }}
              }
              · {{ when(it) }}
            </p>
            <p class="acts">
              @if (it.link) {
                <a [href]="it.link" target="_blank" rel="noopener noreferrer">Open the page</a>
              }
              <button type="button" (click)="items.setRead(it.id, !it.read)">
                {{ it.read ? 'Keep unread' : 'Mark read' }}
              </button>
              <button type="button" (click)="items.setSaved(it.id, !it.saved)">
                {{ it.saved ? 'Unsave' : 'Save for later' }}
              </button>
              @if (it.readerState === 'done') {
                <span class="muted">Reader mode</span>
              } @else {
                <button
                  type="button"
                  [disabled]="it.readerState === 'working' || fetching()"
                  (click)="readerMode(it.id)"
                >
                  {{
                    it.readerState === 'working' || fetching()
                      ? 'Fetching the page…'
                      : 'Reader mode'
                  }}
                </button>
              }
              @if (it.noteId) {
                <a [routerLink]="['/n', it.noteId]">In the garden</a>
              } @else {
                <button type="button" (click)="file(it.id)">File in the garden</button>
              }
            </p>
            @if (said()) {
              <p class="status" role="status">{{ said() }}</p>
            } @else if (it.readerState === 'failed' && it.readerError) {
              <p class="status" role="status">Could not fetch the page: {{ it.readerError }}</p>
            }
          </header>
          @if (it.enclosure) {
            <section class="player" aria-label="Player" data-no-swipe>
              <button
                type="button"
                class="main"
                [attr.aria-label]="playing() ? 'Pause' : 'Play'"
                (click)="toggle(it)"
              >
                {{ playing() ? '❚❚ Pause' : '▶ Play' }}
              </button>
              <input
                type="range"
                aria-label="Position"
                min="0"
                step="1"
                [max]="duration()"
                [value]="shownAt()"
                [attr.aria-valuetext]="items.clock(shownAt()) + ' of ' + items.clock(duration())"
                (input)="scrub.set(+$any($event.target).value)"
                (change)="seekTo(it, $event)"
              />
              <span class="time">{{ items.clock(shownAt()) }} / {{ items.clock(duration()) }}</span>
              <span class="skips">
                <button type="button" aria-label="Back 15 seconds" (click)="skip(it, -15)">
                  −15
                </button>
                <button type="button" aria-label="Forward 30 seconds" (click)="skip(it, 30)">
                  +30
                </button>
                <button
                  type="button"
                  [attr.aria-label]="'Speed ' + rateText()"
                  (click)="player.nextRate()"
                >
                  {{ rateText() }}
                </button>
              </span>
              @if (isCurrent() && player.offer(); as at) {
                <button type="button" (click)="player.takeOffer()">
                  Continue from {{ items.clock(at) }}
                </button>
              }
              @if (it.played) {
                <p class="muted">Played to the end.</p>
              }
              @if (downloads.available()) {
                <p class="download">
                  @if (downloaded(); as kept) {
                    <span class="muted">Downloaded, {{ sizeOf(kept.bytes) }}</span>
                    <button type="button" (click)="downloads.remove(it.id)">Remove download</button>
                  } @else if (progress(); as p) {
                    <span class="muted" role="status">Downloading… {{ progressText(p) }}</span>
                  } @else {
                    <button type="button" (click)="download(it)">Download</button>
                  }
                </p>
              }
            </section>
          }
          <div class="body" [innerHTML]="html()" (click)="openLink($event)"></div>
        </article>
        <nav class="prevnext" aria-label="Next and previous">
          <button type="button" [disabled]="!prev()" (click)="go(-1)">Previous</button>
          <button type="button" [disabled]="!next() && !atEnd()" (click)="go(1)">Next</button>
        </nav>
      } @else if (items.loaded()) {
        <p class="muted">This article is not on this device. Open it online, or go back.</p>
      }
    </main>
  `,
  styles: `
    :host {
      display: block;
      /* Clip, not hidden: hidden would make the host a scroller for a
         pane that reaches below a short article. */
      overflow-x: clip;
    }
    main {
      position: relative;
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
    /* A screenful, from the top of the screen (paneTop), so the title
       is where the eye is; not fixed, since the dragged main's
       transform would make fixed act as absolute anyway. */
    .pane {
      position: absolute;
      top: 0;
      width: 100%;
      height: 100dvh;
      overflow: hidden;
      box-sizing: border-box;
      padding: inherit;
      pointer-events: none;
    }
    .pane.prev {
      right: 100%;
    }
    .pane.next {
      left: 100%;
    }
    h1 {
      overflow-wrap: anywhere;
    }
    .meta,
    .muted,
    .status {
      color: var(--quiet);
      font-size: 14px;
    }
    .acts {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    .player {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: var(--space-2) var(--space-3);
      align-items: center;
      margin: var(--space-3) 0;
      padding: var(--space-3);
      background: var(--surface);
      border: 1px solid var(--rule);
      border-radius: var(--radius-control);
    }
    .player .main {
      grid-row: span 2;
      min-width: 88px;
      min-height: 56px;
      font-size: 18px;
    }
    .player input {
      width: 100%;
    }
    .player .time {
      color: var(--quiet);
      font-size: 14px;
      font-variant-numeric: tabular-nums;
    }
    .player .skips {
      grid-column: 1 / -1;
      display: flex;
      gap: var(--space-2);
    }
    .player .skips button {
      min-width: 48px;
      min-height: 40px;
    }
    .player > :is(button:not(.main), p) {
      grid-column: 1 / -1;
      justify-self: start;
      margin: 0;
    }
    .player .download {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    .body {
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    /* The article's HTML is injected, so these pierce the component's scope. */
    :host ::ng-deep .body :is(h2, h3, h4) {
      margin: 1.2em 0 0.4em;
    }
    :host ::ng-deep .body img,
    :host ::ng-deep .body video,
    :host ::ng-deep .body table {
      max-width: 100%;
      height: auto;
    }
    :host ::ng-deep .body table {
      display: block;
      overflow-x: auto;
    }
    :host ::ng-deep .body pre {
      overflow-x: auto;
      padding: var(--space-2);
      background: var(--chip-bg);
      border-radius: var(--radius-control);
    }
    :host ::ng-deep .body blockquote {
      margin: 0.8em 0;
      padding-left: var(--space-3);
      border-left: 3px solid var(--rule);
      color: var(--quiet);
    }
    :host ::ng-deep .body .no-image {
      color: var(--quiet);
      font-style: italic;
    }
    .prevnext {
      display: flex;
      justify-content: space-between;
      margin-top: var(--space-4);
      padding-top: var(--space-2);
      border-top: 1px solid var(--rule);
    }
  `,
})
export class ReaderArticle {
  protected readonly items = inject(ItemsService);
  protected readonly player = inject(PlayerService);
  protected readonly downloads = inject(DownloadsService);
  private readonly reader = inject(ReaderService);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly route = inject(ActivatedRoute);
  private readonly id = toSignal(this.route.paramMap.pipe(map((p) => p.get('id') ?? '')), {
    initialValue: '',
  });
  private readonly shelf = toSignal(
    this.route.queryParamMap.pipe(map((p) => shelfFromParam(p.get('in')))),
    { initialValue: shelfFromParam(null) },
  );

  /**
   * The story shown: the route's, or the one a finished slide chose a
   * moment before the route caught up, so the switch is in the same
   * frame as the slide's end (review on #169).
   */
  private readonly pendingId = signal<string | undefined>(undefined);
  private readonly currentId = computed(() => this.pendingId() ?? this.id());
  protected readonly item = computed(() => this.items.find(this.currentId()));
  protected readonly fetching = signal(false);
  protected readonly said = signal('');
  protected readonly backLink = computed(() => shelfLink(this.shelf()));
  protected readonly shelfTitle = computed(() => shelfTitle(this.shelf(), this.reader.feeds()));
  protected readonly source = computed(() => this.sourceOf(this.item()));

  /** An episode's player (#179): the player's state once it is in hand, the kept place until then. */
  protected readonly isCurrent = computed(() => {
    const id = this.item()?.id;
    return !!id && this.player.current() === id;
  });
  protected readonly playing = computed(() => this.isCurrent() && this.player.playing());
  protected readonly position = computed(() => {
    if (this.isCurrent()) return this.player.position();
    const it = this.item();
    return it?.played ? 0 : (it?.position ?? 0);
  });
  protected readonly duration = computed(() =>
    this.isCurrent() ? this.player.duration() : (this.item()?.enclosure?.seconds ?? 0),
  );
  protected readonly rateText = computed(() => `${this.player.rate()}×`);
  /** The episode's download, once it is kept on the device (#180). */
  protected readonly downloaded = computed(() => {
    const id = this.item()?.id;
    return id ? this.downloads.record(id) : undefined;
  });
  /** How its download is going, while it is under way. */
  protected readonly progress = computed(() => {
    const id = this.item()?.id;
    return id ? this.downloads.progress()[id] : undefined;
  });
  protected readonly sizeOf = size;

  protected progressText(p: { received: number; total?: number }): string {
    return p.total ? `${Math.floor((p.received / p.total) * 100)}%` : size(p.received);
  }

  /** Download (#180): kept on the device, or the reason it was not, said. */
  protected async download(it: ItemRecord): Promise<void> {
    this.said.set('');
    const why = await this.downloads.download(it);
    if (why) this.said.set(why);
  }
  /** Where the slider is being dragged to, so play does not pull it back mid-drag. */
  protected readonly scrub = signal<number | undefined>(undefined);
  protected readonly shownAt = computed(() => this.scrub() ?? this.position());

  protected toggle(it: ItemRecord): void {
    if (this.isCurrent()) this.player.toggle();
    else this.player.load(it, { autoplay: true });
  }

  protected seekTo(it: ItemRecord, event: Event): void {
    const to = Number((event.target as HTMLInputElement).value);
    this.scrub.set(undefined);
    if (!this.isCurrent()) this.player.load(it, { autoplay: false });
    this.player.seek(to);
  }

  protected skip(it: ItemRecord, by: -15 | 30): void {
    if (!this.isCurrent()) this.player.load(it, { autoplay: false });
    this.player.skip(by);
  }

  protected sourceOf(it: ItemRecord | undefined): string {
    return this.reader.feeds().find((f) => f.id === it?.feedId)?.title ?? 'Unknown feed';
  }

  /** The stories either side, and their HTML rendered once each (review on #169). */
  protected readonly prev = computed(() => this.neighbour(-1));
  protected readonly next = computed(() => this.neighbour(1));
  /** This is the shelf's last article: next is the caught-up page (Eric, 2026-11-07). */
  protected readonly atEnd = computed(() => {
    const seq = this.sequence();
    return seq.length > 0 && seq[seq.length - 1].id === this.currentId();
  });
  /** The slide to the caught-up page finished; it shows here until its route is in. */
  protected readonly pendingDone = signal(false);
  protected readonly prevHtml = computed(() => this.htmlOf(this.prev()));
  protected readonly nextHtml = computed(() => this.htmlOf(this.next()));

  private htmlOf(it: ItemRecord | undefined): SafeHtml | undefined {
    if (!it) return undefined;
    return this.sanitizer.bypassSecurityTrustHtml(
      articleHtml(it.readerContent || it.content || '', this.reader.images()),
    );
  }
  protected readonly html = computed<SafeHtml>(() => {
    const it = this.item();
    const markdown = it?.readerContent || it?.content || '';
    // Sanitized by renderNoteHtml (rehype-sanitize); Angular's own pass
    // would strip the image attributes, so it is trusted as it is.
    return this.sanitizer.bypassSecurityTrustHtml(articleHtml(markdown, this.reader.images()));
  });
  private readonly swipe = viewChild(Swipe);
  private readonly main = viewChild<ElementRef<HTMLElement>>('main');
  protected readonly dragging = computed(() => (this.swipe()?.dx() ?? 0) !== 0);
  /**
   * Where the panes start, measured once as a drag begins: the top of
   * the screen within the article, so the story either side has its
   * title at the top however far down this one is read, and go()'s
   * scroll to the top leaves the arriving story where its pane was
   * (Eric, 2026-11-07).
   */
  protected readonly paneTop = computed(() =>
    this.dragging()
      ? untracked(() => Math.max(0, -(this.main()?.nativeElement.getBoundingClientRect().top ?? 0)))
      : 0,
  );
  /** The articles opened in this sitting: read now, but still on the way back. */
  private readonly visited = signal<ReadonlySet<string>>(new Set());
  /**
   * The articles around this one on its shelf: the unread ones, this,
   * and the ones read on the way here, so a swipe back finds the
   * previous story (Eric, 2026-11-07).
   */
  private readonly sequence = computed(() => {
    const id = this.currentId();
    const visited = this.visited();
    return this.items
      .inShelf(this.shelf(), true)
      .filter((i) => !i.read || i.id === id || visited.has(i.id));
  });

  constructor() {
    // The route caught up with a slide's choice.
    effect(() => {
      if (this.pendingId() !== undefined && this.id() === this.pendingId()) {
        this.pendingId.set(undefined);
      }
    });
    // Opening an article reads it, once it is here, and keeps it in the
    // sequence for the way back. An episode is read once it is heard to
    // the end (#179).
    let marked = '';
    effect(() => {
      const it = this.item();
      if (!it) return;
      if (!this.visited().has(it.id)) {
        this.visited.update((v) => new Set([...v, it.id]));
      }
      if (it.read || it.enclosure || marked === it.id) return;
      marked = it.id;
      this.items.setRead(it.id, true);
    });
  }

  /** Reader mode (#163): the page's article, fetched by the server, kept on the item. */
  protected async readerMode(id: string): Promise<void> {
    this.fetching.set(true);
    this.said.set('');
    try {
      const why = await this.items.readerMode(id);
      if (why) this.said.set(why);
    } finally {
      this.fetching.set(false);
    }
  }

  /** File in the garden (#163): a clipping, made at once; its link shows in place. */
  protected file(id: string): void {
    const noteId = this.items.fileInGarden(id);
    this.said.set(noteId ? 'Filed in the garden.' : 'Could not file it; try again online.');
  }

  protected neighbour(step: 1 | -1): ItemRecord | undefined {
    const seq = this.sequence();
    const at = seq.findIndex((i) => i.id === this.currentId());
    return at < 0 ? undefined : seq[at + step];
  }

  protected go(step: 1 | -1): void {
    const next = this.neighbour(step);
    if (!next && step === 1 && this.atEnd() && !this.pendingDone()) {
      this.pendingDone.set(true);
      // A history entry of its own, so going back from it is this article.
      void this.router
        .navigate(['/reader/done'], { queryParams: { in: shelfParam(this.shelf()) } })
        .then((ok) => {
          if (!ok) this.pendingDone.set(false);
        });
      window.scrollTo({ top: 0 });
      return;
    }
    if (!next) return;
    this.pendingId.set(next.id);
    void this.router.navigate(['/reader/a', next.id], {
      queryParams: { in: shelfParam(this.shelf()) },
      replaceUrl: true,
    });
    window.scrollTo({ top: 0 });
  }

  protected when(it: ItemRecord): string {
    return new Date(it.published).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  /** A link in the article opens in a new tab, never over the reader. */
  protected openLink(event: MouseEvent): void {
    const a = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    event.preventDefault();
    // A footnote's link to a place in the article scrolls to it: left to
    // the page it would resolve against the app's base href and leave the
    // article (review on #167).
    const fragment = a.getAttribute('href') ?? '';
    if (fragment.startsWith('#')) {
      let id = fragment.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // A malformed escape: the name as written, then (review on #167).
      }
      const body = a.closest('.body');
      const target =
        body?.querySelector(`#${CSS.escape(id)}`) ??
        body?.querySelector(`[name="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ block: 'start' });
      return;
    }
    window.open(a.href, '_blank', 'noopener');
  }

  @HostListener('document:keydown', ['$event'])
  protected keys(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const it = this.item();
    switch (event.key) {
      case 'j':
        this.go(1);
        break;
      case 'k':
        this.go(-1);
        break;
      case 'm':
        if (it) this.items.setRead(it.id, !it.read);
        break;
      case 's':
        if (it) this.items.setSaved(it.id, !it.saved);
        break;
      case 'v':
        if (it?.link) window.open(it.link, '_blank', 'noopener');
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
