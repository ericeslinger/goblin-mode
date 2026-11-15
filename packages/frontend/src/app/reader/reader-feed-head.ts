import {
  Component,
  type ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Icon } from '../home/icon';
import { NOW } from '../platform/platform';
import { FeedFix } from './feed-fix';
import { type Fix, feedTrouble, looksText, newestText, nextText } from './feed-health';
import { renamedFolder } from './reader-feeds';
import { type FeedRecord, ReaderService, type Switched } from './reader.service';

/** What the More sheet shows: its buttons, a field, or the confirm. */
type Step = 'menu' | 'rename' | 'folders' | 'remove';

/** A link shown only when it is a web link: the feed's site is content from the web. */
function webLink(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/**
 * One feed's page (2026-11-15, Eric: "a single feed view page which
 * lists recent posts from the feed and has the metadata edit plus other
 * actions"): the head of the feed's own list (`/reader/s/<feedId>`),
 * whose articles are its recent posts. Its address in full, selectable,
 * with Copy; its site; its folders; the Reader or Podcasts; when it was
 * looked at and will be next, and the newest article; its state, fine,
 * failing with why, or given up. Look again and Find the feed (then
 * Switch to it) are on the page (`FeedFix`); More is a sheet, as a
 * show's page has (#246): Rename, Folders, Move to Podcasts and
 * Remove, which asks first.
 */
@Component({
  selector: 'app-reader-feed-head',
  imports: [FeedFix, Icon, RouterLink],
  template: `
    @if (feed(); as f) {
      <section class="about" aria-labelledby="about-feed">
        <div class="top">
          <h3 id="about-feed">About this feed</h3>
          <button
            type="button"
            class="icon"
            aria-haspopup="dialog"
            [attr.aria-label]="'More for ' + f.title"
            (click)="openMore()"
          >
            <app-icon name="more" [size]="22" />
          </button>
        </div>
        <dl>
          <dt>Address</dt>
          <dd class="address">
            <span class="url">{{ f.url || 'None: saved articles imported from Feedly' }}</span>
            @if (f.url) {
              <button type="button" class="copy" (click)="copy(f.url)">Copy address</button>
            }
          </dd>
          @if (site(); as s) {
            <dt>Site</dt>
            <dd>
              <a class="url" [href]="s" target="_blank" rel="noopener noreferrer">{{ s }}</a>
            </dd>
          }
          <dt>Folders</dt>
          <dd>{{ f.folders.length ? f.folders.join(', ') : 'Not in a folder' }}</dd>
          <dt>Filed in</dt>
          <dd>
            @if (f.kind === 'podcast') {
              Podcasts: <a [routerLink]="['/podcasts/s', f.id]">its show page</a>
            } @else {
              The Reader
            }
          </dd>
          <dt>State</dt>
          <dd>{{ stateText() }}</dd>
          @if (f.url) {
            <dt>Looks</dt>
            <dd>{{ looks() }}</dd>
          }
        </dl>
        @if (f.url) {
          <app-feed-fix
            [feed]="f"
            [fixes]="fixes()"
            (said)="said.set($event)"
            (switched)="followNew($event)"
          />
        }
        @if (said()) {
          <p class="said" role="status">{{ said() }}</p>
        }
        <dialog
          #more
          class="sheet"
          [attr.aria-label]="'More for ' + f.title"
          (close)="step.set('menu')"
          (click)="backdrop($event)"
        >
          <p class="sheet-name">{{ f.title }}</p>
          @switch (step()) {
            @case ('rename') {
              <form class="field-form" novalidate (submit)="rename($event, f, nameInput.value)">
                <label class="field">
                  Name
                  <input #nameInput [value]="f.title" enterkeyhint="done" />
                </label>
                <button type="submit">Rename</button>
                <button type="button" (click)="go('menu')">Back</button>
              </form>
            }
            @case ('folders') {
              <form
                class="field-form"
                novalidate
                (submit)="setFolders($event, f, foldersInput.value)"
              >
                <label class="field">
                  Folders, comma separated
                  <input
                    #foldersInput
                    [value]="f.folders.join(', ')"
                    placeholder="Not in a folder"
                    enterkeyhint="done"
                  />
                </label>
                <p class="muted">Empty takes it out of its folders.</p>
                <button type="submit">Save folders</button>
                <button type="button" (click)="go('menu')">Back</button>
              </form>
            }
            @case ('remove') {
              <p>
                Remove {{ f.title }}? Its articles go with it, but for any saved or filed in the
                garden.
              </p>
              <button type="button" class="danger" (click)="remove(f)">Remove {{ f.title }}</button>
              <button type="button" (click)="go('menu')">Keep following</button>
            }
            @default {
              <button type="button" (click)="go('rename')">Rename</button>
              <button type="button" (click)="go('folders')">Folders</button>
              @if (f.url && f.kind !== 'podcast') {
                <button type="button" (click)="toPodcasts(f)">
                  Move to Podcasts
                  <span class="hint">For a feed that is mostly audio</span>
                </button>
              }
              <button type="button" (click)="go('remove')">Remove</button>
              <button type="button" (click)="closeMore()">Close</button>
            }
          }
        </dialog>
      </section>
    }
  `,
  styles: `
    .about {
      display: grid;
      gap: var(--space-2);
      margin: var(--space-2) 0 var(--space-3);
      padding: var(--space-2) var(--space-3);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-card);
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    h3 {
      margin: 0;
      font-size: 15px;
    }
    .icon {
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
    dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px var(--space-3);
      margin: 0;
      font-size: 14px;
    }
    dt {
      color: var(--quiet);
    }
    dd {
      margin: 0;
      min-width: 0;
    }
    .url {
      overflow-wrap: anywhere;
      user-select: text;
    }
    .address {
      display: flex;
      flex-wrap: wrap;
      gap: 4px var(--space-2);
      align-items: center;
    }
    .said,
    .muted,
    .hint {
      margin: 0;
      color: var(--quiet);
      font-size: 14px;
      font-weight: 400;
    }
    .sheet {
      box-sizing: border-box;
      width: min(100% - 32px, 420px);
      margin: auto auto 16px;
      padding: var(--space-3);
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-card);
    }
    .sheet::backdrop {
      background: color-mix(in srgb, var(--ink) 35%, transparent);
    }
    .sheet[open],
    .sheet .field-form {
      display: grid;
      gap: var(--space-2);
    }
    .sheet-name {
      margin: 0;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .sheet p {
      margin: 0;
    }
    .sheet button {
      display: grid;
      justify-items: start;
      gap: 2px;
      min-height: 44px;
      padding: 6px 12px;
      font: inherit;
      text-align: left;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      cursor: pointer;
    }
    .sheet .danger {
      font-weight: 600;
      border-color: var(--ink);
    }
    .field {
      display: grid;
      gap: 4px;
    }
    .field input {
      min-height: 44px;
      font: inherit;
    }
  `,
})
export class ReaderFeedHead {
  protected readonly reader = inject(ReaderService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly now = inject(NOW);
  private readonly moreDialog = viewChild<ElementRef<HTMLDialogElement>>('more');

  readonly feedId = input.required<string>();
  protected readonly feed = computed(() => this.reader.feeds().find((f) => f.id === this.feedId()));
  protected readonly trouble = computed(() => {
    const f = this.feed();
    return f ? feedTrouble(f) : undefined;
  });
  protected readonly site = computed(() => webLink(this.feed()?.site));
  /** Remove is in More, so the page's own fixes leave it out. */
  protected readonly fixes = computed<Fix[]>(() =>
    (this.trouble()?.fixes ?? ['retry', 'find']).filter((x) => x !== 'remove'),
  );
  protected readonly stateText = computed(() => {
    const f = this.feed();
    if (!f) return '';
    if (!f.url) return 'Nothing to look at.';
    const t = this.trouble();
    if (t) return t.words;
    if (f.fetchedAt === undefined) return 'Not looked at yet.';
    // Due, or asked to look again: the last answer is not known to
    // be good until the next look comes back (review on #275).
    if (f.nextFetchAt !== undefined && f.nextFetchAt <= this.now()) {
      return 'Waiting for its next look.';
    }
    return 'Fine: the last look read it.';
  });
  protected readonly looks = computed(() => {
    const f = this.feed();
    if (!f) return '';
    const now = this.now();
    return [looksText(f, now), nextText(f, now), newestText(f, now)].join(' ');
  });
  protected readonly said = signal('');
  protected readonly step = signal<Step>('menu');

  /** Copies the feed's address; said either way, with the address when the clipboard refuses. */
  protected async copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.said.set('Address copied.');
    } catch {
      this.said.set(`Could not copy; the address is ${url}`);
    }
  }

  /** The feed followed in this one's place: its page, in place of this one's in the history. */
  protected followNew(to: Switched): void {
    void this.router.navigate(['/reader/s', to.id], { replaceUrl: true });
  }

  protected openMore(): void {
    this.step.set('menu');
    this.moreDialog()?.nativeElement.showModal();
  }

  protected closeMore(): void {
    this.moreDialog()?.nativeElement.close();
  }

  /** A click on the sheet's backdrop closes it, as Escape does. */
  protected backdrop(event: MouseEvent): void {
    if (event.target === this.moreDialog()?.nativeElement) this.closeMore();
  }

  /** Another step of the sheet, its first control focused so focus stays inside. */
  protected go(step: Step): void {
    this.step.set(step);
    afterNextRender(
      () => this.moreDialog()?.nativeElement.querySelector<HTMLElement>('input, button')?.focus(),
      { injector: this.injector },
    );
  }

  protected rename(event: Event, feed: FeedRecord, text: string): void {
    event.preventDefault();
    const title = this.reader.setTitle(feed.id, text);
    this.said.set(title ? `Renamed to ${title}.` : 'A feed needs a name; it keeps the one it has.');
    this.closeMore();
  }

  protected setFolders(event: Event, feed: FeedRecord, value: string): void {
    event.preventDefault();
    const names = value.split(',');
    this.reader.setFolders(feed.id, names);
    const kept = this.reader.feeds().find((f) => f.id === feed.id)?.folders ?? [];
    this.said.set(
      renamedFolder(names) || (kept.length ? `In ${kept.join(', ')} now.` : 'In no folder now.'),
    );
    this.closeMore();
  }

  /** Move to Podcasts (#245): the feed leaves the Reader for the shows; its page there. */
  protected toPodcasts(feed: FeedRecord): void {
    this.closeMore();
    this.reader.setPodcast(feed.id, true);
    this.said.set(`${feed.title} is in Podcasts now.`);
  }

  protected remove(feed: FeedRecord): void {
    this.closeMore();
    this.reader.removeFeed(feed.id);
    void this.router.navigate(['/reader/feeds'], { replaceUrl: true });
  }
}
