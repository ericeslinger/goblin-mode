import { Component, HostListener, computed, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { renderNoteHtml } from '@mossgoblin/editor';
import { map } from 'rxjs';
import { type ItemRecord, ItemsService } from './items.service';
import { shelfFromParam, shelfParam } from './reader-list';
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
 * k. Opening marks it read; links inside open in a new tab.
 */
@Component({
  selector: 'app-reader-article',
  imports: [RouterLink, Swipe],
  template: `
    <main class="page" appSwipe (left)="go(1)" (right)="go(-1)">
      <a [routerLink]="backLink()" class="back">Back</a>
      @if (item(); as it) {
        <article>
          <header>
            <h1>{{ it.title }}</h1>
            <p class="meta">
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
            </p>
          </header>
          <div class="body" [innerHTML]="html()" (click)="openLink($event)"></div>
        </article>
        <nav class="prevnext" aria-label="Next and previous">
          <button type="button" [disabled]="!neighbour(-1)" (click)="go(-1)">Previous</button>
          <button type="button" [disabled]="!neighbour(1)" (click)="go(1)">Next</button>
        </nav>
      } @else if (items.loaded()) {
        <p class="muted">This article is not on this device. Open it online, or go back.</p>
      }
    </main>
  `,
  styles: `
    main {
      touch-action: pan-y;
    }
    h1 {
      overflow-wrap: anywhere;
    }
    .meta,
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
    .acts {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    .body {
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .body :is(h2, h3, h4) {
      margin: 1.2em 0 0.4em;
    }
    .body img {
      max-width: 100%;
      height: auto;
    }
    .body pre {
      overflow-x: auto;
      padding: var(--space-2);
      background: var(--chip-bg);
      border-radius: var(--radius-control);
    }
    .body blockquote {
      margin: 0.8em 0;
      padding-left: var(--space-3);
      border-left: 3px solid var(--rule);
      color: var(--quiet);
    }
    .body .no-image {
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

  protected readonly item = computed(() => this.items.find(this.id()));
  protected readonly backLink = computed(() => {
    const shelf = this.shelf();
    return shelf.kind === 'feed' ? ['/reader/s', shelf.id] : ['/reader/f', shelf.name];
  });
  protected readonly source = computed(
    () => this.reader.feeds().find((f) => f.id === this.item()?.feedId)?.title ?? 'Unknown feed',
  );
  protected readonly html = computed<SafeHtml>(() => {
    const it = this.item();
    const markdown = it?.readerContent || it?.content || '';
    // Sanitized by renderNoteHtml (rehype-sanitize); Angular's own pass
    // would strip the image attributes, so it is trusted as it is.
    return this.sanitizer.bypassSecurityTrustHtml(articleHtml(markdown, this.reader.images()));
  });
  /** The articles around this one on its shelf: the unread ones, and this. */
  private readonly sequence = computed(() => {
    const id = this.id();
    return this.items.inShelf(this.shelf(), true).filter((i) => !i.read || i.id === id);
  });

  constructor() {
    // Opening an article reads it, once it is here.
    let marked = '';
    effect(() => {
      const it = this.item();
      if (!it || it.read || marked === it.id) return;
      marked = it.id;
      this.items.setRead(it.id, true);
    });
  }

  protected neighbour(step: 1 | -1): ItemRecord | undefined {
    const seq = this.sequence();
    const at = seq.findIndex((i) => i.id === this.id());
    return at < 0 ? undefined : seq[at + step];
  }

  protected go(step: 1 | -1): void {
    const next = this.neighbour(step);
    if (!next) return;
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
    // A footnote's link to a place in the article stays in it (review on #167).
    if (a.getAttribute('href')?.startsWith('#')) return;
    event.preventDefault();
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
