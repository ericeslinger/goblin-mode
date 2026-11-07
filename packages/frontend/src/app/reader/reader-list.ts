import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { ALL, type ItemRecord, ItemsService, SAVED, type Shelf2 } from './items.service';
import { ReaderService } from './reader.service';
import { Swipe } from './swipe';

/** The shelf a list shows, from its route: `/reader/f/<folder>` or `/reader/s/<feedId>`. */
export function shelfOf(params: { get(name: string): string | null }): Shelf2 {
  const feed = params.get('feedId');
  return feed ? { kind: 'feed', id: feed } : { kind: 'folder', name: params.get('folder') ?? ALL };
}

/** A shelf as the article's `in` query parameter carries it. */
export function shelfParam(shelf: Shelf2): string {
  return shelf.kind === 'feed' ? `s:${shelf.id}` : `f:${shelf.name}`;
}

export function shelfFromParam(value: string | null): Shelf2 {
  if (value?.startsWith('s:')) return { kind: 'feed', id: value.slice(2) };
  if (value?.startsWith('f:')) return { kind: 'folder', name: value.slice(2) };
  return { kind: 'folder', name: ALL };
}

/**
 * The compact list (#162): a folder's or a feed's articles, newest
 * first, unread unless Show read. Swipe a row left to mark it read,
 * right to save it (buttons do the same for keyboards and screen
 * readers); tap to open. On a keyboard j and k move, m marks read, s
 * saves, Enter opens.
 */
@Component({
  selector: 'app-reader-list',
  imports: [RouterLink, Swipe],
  template: `
    <main class="page">
      <a routerLink="/reader">Back</a>
      <h1>{{ title() }}</h1>
      <p class="tools">
        <label>
          <input type="checkbox" [checked]="showRead()" (change)="showRead.set(!showRead())" />
          Show read
        </label>
        <button type="button" [disabled]="!unreadCount()" (click)="markAll()">Mark all read</button>
        @if (feedLink()) {
          <a [href]="feedLink()" target="_blank" rel="noopener noreferrer">The site</a>
        }
      </p>
      @if (status()) {
        <p class="status" role="status">{{ status() }}</p>
      }
      @if (items.loaded() && list().length === 0) {
        <p class="muted">
          {{ isSaved() ? 'Nothing saved for later.' : 'All caught up.' }}
        </p>
      }
      <ul aria-label="Articles">
        @for (item of list(); track item.id; let i = $index) {
          <li
            appSwipe
            [class.read]="item.read"
            [class.cursor]="i === cursor()"
            (left)="items.setRead(item.id, true)"
            (right)="items.setSaved(item.id, !item.saved)"
          >
            <a
              class="open"
              draggable="false"
              [routerLink]="['/reader/a', item.id]"
              [queryParams]="{ in: param() }"
              [attr.aria-current]="i === cursor() ? 'true' : null"
            >
              <span class="title">{{ item.title }}</span>
              <span class="meta">
                {{ source(item) }} · {{ items.age(item.published) }}
                @if (item.saved) {
                  <span class="saved" role="img" aria-label="saved">★</span>
                }
                @if (item.noteId) {
                  <span class="filed" role="img" aria-label="in the garden">🌱</span>
                }
              </span>
              @if (item.summary) {
                <span class="summary">{{ item.summary }}</span>
              }
            </a>
            <span class="acts">
              <button
                type="button"
                [attr.aria-label]="(item.read ? 'Mark unread: ' : 'Mark read: ') + item.title"
                (click)="items.setRead(item.id, !item.read)"
              >
                {{ item.read ? 'Unread' : 'Read' }}
              </button>
              <button
                type="button"
                [attr.aria-label]="(item.saved ? 'Unsave: ' : 'Save: ') + item.title"
                (click)="items.setSaved(item.id, !item.saved)"
              >
                {{ item.saved ? 'Unsave' : 'Save' }}
              </button>
            </span>
          </li>
        }
      </ul>
    </main>
  `,
  styles: `
    .tools {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: var(--space-2);
      align-items: center;
      border-bottom: 1px solid var(--rule);
      background: var(--surface);
      touch-action: pan-y;
    }
    li.swiping {
      transition: none;
    }
    li.settling {
      transition: transform 180ms ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      li.settling {
        transition: none;
      }
    }
    li.cursor {
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .open {
      display: grid;
      gap: 2px;
      padding: 10px 4px;
      color: var(--ink);
      text-decoration: none;
      min-width: 0;
    }
    .title {
      font-weight: 600;
    }
    li.read .title {
      font-weight: 400;
      color: var(--quiet);
    }
    .meta,
    .muted,
    .status {
      color: var(--quiet);
      font-size: 14px;
    }
    .summary {
      font-size: 14px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      overflow-wrap: anywhere;
    }
    .acts {
      display: grid;
      gap: 4px;
      padding-right: 4px;
    }
    .acts button {
      min-height: 32px;
    }
    @media (pointer: coarse) {
      .acts {
        display: none;
      }
    }
  `,
})
export class ReaderList {
  protected readonly items = inject(ItemsService);
  protected readonly reader = inject(ReaderService);
  private readonly router = inject(Router);
  private readonly shelf = toSignal(inject(ActivatedRoute).paramMap.pipe(map(shelfOf)), {
    initialValue: { kind: 'folder', name: ALL } as Shelf2,
  });
  protected readonly showRead = signal(false);
  protected readonly status = signal('');
  protected readonly cursor = signal(-1);

  protected readonly isSaved = computed(
    () => this.shelf().kind === 'folder' && (this.shelf() as { name: string }).name === SAVED,
  );
  protected readonly param = computed(() => shelfParam(this.shelf()));
  protected readonly list = computed(() => this.items.inShelf(this.shelf(), this.showRead()));
  protected readonly unreadCount = computed(() => this.list().filter((i) => !i.read).length);
  protected readonly title = computed(() => {
    const shelf = this.shelf();
    if (shelf.kind === 'feed')
      return this.reader.feeds().find((f) => f.id === shelf.id)?.title ?? 'Feed';
    return shelf.name === ALL ? 'All' : shelf.name === SAVED ? 'Saved' : shelf.name;
  });
  /** One feed's site, when the list is that feed's. */
  protected readonly feedLink = computed(() => {
    const shelf = this.shelf();
    if (shelf.kind !== 'feed') return undefined;
    const feed = this.reader.feeds().find((f) => f.id === shelf.id);
    return feed?.site ?? feed?.url;
  });

  protected source(item: ItemRecord): string {
    return this.reader.feeds().find((f) => f.id === item.feedId)?.title ?? 'Unknown feed';
  }

  protected markAll(): void {
    const n = this.items.markAllRead(this.shelf());
    this.status.set(n ? `${n} marked read.` : 'Nothing to mark.');
  }

  @HostListener('document:keydown', ['$event'])
  protected keys(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const list = this.list();
    const at = this.cursor();
    const current = list[at];
    switch (event.key) {
      case 'j':
        this.moveCursor(Math.min(at + 1, list.length - 1));
        break;
      case 'k':
        this.moveCursor(Math.max(at - 1, 0));
        break;
      case 'm':
        if (current) this.items.setRead(current.id, !current.read);
        break;
      case 's':
        if (current) this.items.setSaved(current.id, !current.saved);
        break;
      case 'Enter':
      case 'o':
        if (current) {
          void this.router.navigate(['/reader/a', current.id], {
            queryParams: { in: this.param() },
          });
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private moveCursor(to: number): void {
    this.cursor.set(to);
    document.querySelectorAll('app-reader-list li')[to]?.scrollIntoView({ block: 'nearest' });
  }
}
