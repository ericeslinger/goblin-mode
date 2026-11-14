import {
  Component,
  DestroyRef,
  type ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { hostOf } from '@mossgoblin/schema';
import { AuthService } from '../auth.service';
import { CaptureService } from '../capture/capture.service';
import { HomeLink } from '../home/home-link';
import { MAX_PASTED_CHARS, RECIPE_IMPORT_API } from '../kitchen/recipe-paste';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW, ONLINE } from '../platform/platform';
import { ReadingService } from '../reading/reading.service';
import { type PendingShare, ShareStore } from './share-store';
import { openedHere, parseShare, shareNoteText } from './shared';

/** How much of the shared words the page shows; all of them are kept. */
export const PREVIEW_CHARS = 600;
/** How long the recipe's write may take to reach the server before the import is asked. */
export const WRITE_WAIT_MS = 20_000;

/**
 * Share to Mossgoblin (2026-11-14, DESIGN.md): what Android's share
 * sheet sent, kept on the device the moment this page opens, and the
 * ways to file it, one tap each. Words with no link become a note at
 * once, with no tap, as they did before (#42, 2026-10-08), once the
 * notes are here; a link alone can be saved to read later; with
 * Kitchen on, a link can be imported as a recipe, and words shared
 * from a recipe's page (select all, share) are read as Paste the page
 * instead reads them, for a site that will not let Mossgoblin read it.
 * A share waits here, through sign-in and offline, until it is filed.
 */
@Component({
  selector: 'app-share',
  imports: [HomeLink, RouterLink],
  template: `
    <main class="page share">
      <app-home-link />
      <h1 #heading tabindex="-1">Shared with Mossgoblin</h1>
      @if (share(); as s) {
        <section class="shared" aria-label="What was shared">
          @if (s.title) {
            <p class="title">{{ s.title }}</p>
          }
          @if (s.words) {
            <p class="words">{{ preview(s.words) }}</p>
          }
          @if (s.link) {
            <p class="link">
              <a [href]="s.link" target="_blank" rel="noopener noreferrer">{{ s.link }}</a>
            </p>
          }
        </section>
        @if (!store.kept()) {
          <p class="warn" role="alert">
            This share is too long to keep on this device until it is filed, so it is lost if this
            page closes first. File it now.
          </p>
        }
        @if (auth.user() === null) {
          <p class="muted">It is kept on this device. Sign in to file it.</p>
          <div class="actions">
            <button #first type="button" class="primary" (click)="signIn()">
              Sign in with Google
            </button>
            @if (auth.usingEmulators) {
              <a routerLink="/dev-sign-in">Dev sign-in</a>
            }
          </div>
        } @else if (!notesReady()) {
          <p class="muted" role="status">
            It is kept on this device, and can be filed as soon as your notes are here.
          </p>
        } @else if (!s.link) {
          <p class="muted" role="status">Keeping it as a note…</p>
        } @else {
          <div class="actions" role="group" aria-label="File it">
            @if (!s.words && s.link) {
              <button #first type="button" [disabled]="busy()" (click)="readLater(s)">
                Save to read later
              </button>
              <button type="button" [disabled]="busy()" (click)="keepAsNote(s)">
                Keep as a note
              </button>
              @if (modules.kitchen()) {
                <button type="button" [disabled]="busy()" (click)="importLink(s)">
                  Import as a recipe
                </button>
              }
            } @else {
              <button #first type="button" [disabled]="busy()" (click)="keepAsNote(s)">
                Keep as a note
              </button>
              @if (s.link && modules.kitchen()) {
                <button type="button" [disabled]="busy()" (click)="importFromText(s)">
                  Import as a recipe from this text
                </button>
              }
            }
            <button type="button" class="quiet" [disabled]="busy()" (click)="letGo(s)">
              Let it go
            </button>
          </div>
        }
        <p class="said" role="status">{{ said() }}</p>
        @if (store.pending().length > 1) {
          <p class="muted">
            {{ store.pending().length - 1 }} more
            {{ store.pending().length === 2 ? 'share waits' : 'shares wait' }} after this one.
          </p>
        }
      } @else {
        <p class="muted">Nothing shared is waiting to be filed.</p>
        @if (said()) {
          <p class="said" role="status">{{ said() }}</p>
        }
      }
    </main>
  `,
  styles: `
    h1:focus {
      outline: none;
    }
    .shared {
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-card);
      background: var(--surface);
      padding: var(--space-2) var(--space-3);
      margin: 0 0 var(--space-3);
    }
    .shared p {
      margin: var(--space-2) 0;
      overflow-wrap: anywhere;
    }
    .title {
      font-weight: 600;
    }
    .words {
      white-space: pre-wrap;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      margin: 0 0 var(--space-2);
    }
    .actions button {
      font: inherit;
      min-height: 44px;
      padding: var(--space-2) var(--space-3);
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      cursor: pointer;
    }
    .actions button:first-child,
    .actions .primary {
      color: var(--on-accent);
      background: var(--accent);
      border-color: var(--accent);
    }
    .actions .quiet {
      color: var(--accent);
      background: none;
      border-color: transparent;
      text-decoration: underline;
    }
    .muted,
    .said {
      color: var(--quiet);
    }
    .said:empty {
      display: none;
    }
    .warn {
      color: var(--ink);
      font-weight: 600;
    }
  `,
})
export class Share {
  protected readonly auth = inject(AuthService);
  protected readonly modules = inject(ModulesService);
  protected readonly store = inject(ShareStore);
  private readonly notes = inject(NotesService);
  private readonly capture = inject(CaptureService);
  private readonly reading = inject(ReadingService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly isOnline = inject(ONLINE);

  /** The share shown: the newest waiting, so the one just shared comes first. */
  protected readonly share = computed(() => this.store.pending().at(-1));
  protected readonly busy = signal(false);
  protected readonly said = signal('');
  private readonly online = signal(this.isOnline());
  /** `ready` is a getter over signals, so this follows sign-in and the notes loading. */
  protected readonly notesReady = computed(() => !!this.auth.user() && this.notes.ready);

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly first = viewChild<ElementRef<HTMLElement>>('first');

  constructor() {
    // Taken in first, before anything waits on auth or the network: the
    // words go into this device's store, then out of the address, so a
    // reload neither loses nor files them twice.
    const route = inject(ActivatedRoute);
    const doc = inject(DOCUMENT);
    const params = route.snapshot.queryParamMap;
    if (params.keys.length) {
      // Only from this device: another site's link must not plant words
      // a later Claude would read (review on #98).
      if (openedHere(doc.referrer, doc.location.origin)) {
        const shared = parseShare({
          title: params.get('title'),
          text: params.get('text'),
          url: params.get('url'),
          at: params.get('at'),
        });
        if (!shared) this.said.set('Nothing came with that share.');
        else if (!this.store.take(shared, inject(NOW)())) {
          this.said.set('That share has been filed already.');
        }
      }
      void this.router.navigate([], { relativeTo: route, queryParams: {}, replaceUrl: true });
    }

    // Words with no link have one way to go: a note, at once, as before
    // the landing step (#42, 2026-10-08), as soon as the notes are here
    // (signed out, the share waits above for sign-in).
    effect(() => {
      const s = this.share();
      if (!s || s.link || !this.notesReady() || this.busy()) return;
      untracked(() => this.keepAsNote(s, { replaceUrl: true }));
    });

    // Focus on arrival, and on the next share once one is filed: its
    // first action, else the heading.
    const shown = computed(() => `${this.share()?.key}|${this.notesReady()}|${this.auth.user()}`);
    effect(() => {
      shown();
      untracked(() =>
        afterNextRender(() => (this.first() ?? this.heading())?.nativeElement.focus(), {
          injector: this.injector,
        }),
      );
    });

    const view = doc.defaultView;
    const update = () => this.online.set(this.isOnline());
    view?.addEventListener('online', update);
    view?.addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      view?.removeEventListener('online', update);
      view?.removeEventListener('offline', update);
    });
  }

  protected preview(words: string): string {
    if (words.length <= PREVIEW_CHARS) return words;
    const rest = words.length - PREVIEW_CHARS;
    return `${words.slice(0, PREVIEW_CHARS).trimEnd()}… and ${rest.toLocaleString()} more characters`;
  }

  protected signIn(): void {
    this.auth.signInWithGoogle().catch((err) => console.error(err));
  }

  /**
   * As a share became a note before (#42): a new capture note holding
   * the words, the title and the link, written at once (kept until the
   * server has it, #200), and opened at `/`, where a share always
   * landed. Filed with no tap, the share page leaves history with it.
   */
  protected keepAsNote(s: PendingShare, { replaceUrl = false } = {}): void {
    if (this.busy() || !this.notesReady()) return;
    this.capture.newNote();
    this.capture.replace(shareNoteText(s));
    this.capture.flush();
    this.store.done(s.key);
    void this.router.navigate(['/'], { replaceUrl });
  }

  /** Into the reading queue (#48), offline too; its page is fetched on the server. */
  protected readLater(s: PendingShare): void {
    if (this.busy() || !this.notesReady()) return;
    if (!this.reading.save(s.link)) {
      this.said.set('That link cannot be saved to read: it is not a web address.');
      return;
    }
    this.store.done(s.key);
    void this.router.navigate(['/reading']);
  }

  /** As Import from a link does (#128): the server reads the page, offline or not. */
  protected importLink(s: PendingShare): void {
    if (this.busy() || !this.notesReady()) return;
    const id = this.notes.importRecipe(s.link);
    if (!id) {
      this.said.set('That link cannot be imported: it is not a web address.');
      return;
    }
    this.store.done(s.key);
    void this.router.navigate(['/n', id]);
  }

  /**
   * Words shared from a recipe's page, read as Paste the page instead
   * reads them (2026-11-14): Eric's recipe is made first, on the device,
   * as an import already failed (so the trigger never claims it), then
   * the words go to `importPastedRecipe` for it, the link kept as its
   * source. It needs a connection; until it is done, the share waits
   * here, and asking again reuses the same recipe.
   */
  protected async importFromText(s: PendingShare): Promise<void> {
    if (this.busy() || !this.notesReady()) return;
    if (s.words.length > MAX_PASTED_CHARS) {
      this.said.set('That is over a million characters, more than a recipe import reads.');
      return;
    }
    if (!this.online()) {
      this.said.set(
        'Importing from what was shared needs a connection. The share waits here until then, ' +
          'or keep it as a note.',
      );
      return;
    }
    const id = s.recipeId ?? this.notes.newId();
    if (!s.recipeId) this.store.update(s.key, { recipeId: id });
    const written = this.notes.sharedRecipe(s.link, id);
    if (!written) {
      this.said.set('That link cannot be imported: it is not a web address.');
      return;
    }
    this.busy.set(true);
    this.said.set(`Reading the recipe from what was shared from ${hostOf(s.link) || 'the page'}…`);
    try {
      await within(written, WRITE_WAIT_MS);
      const result = await this.injector.get(RECIPE_IMPORT_API).importPasted(id, s.words);
      if (result.state === 'done') {
        this.said.set('');
        this.store.done(s.key);
        void this.router.navigate(['/n', id]);
        return;
      }
      this.notes.importFailed(id, result.error);
      this.said.set(
        `Could not import it: ${result.error}. The recipe is kept with its link, and this ` +
          'share waits here, to keep as a note.',
      );
    } catch (err) {
      this.said.set(failure(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Not wanted after all: forgotten, as nothing was filed. */
  protected letGo(s: PendingShare): void {
    if (this.busy()) return;
    this.store.done(s.key);
    this.said.set('Let go.');
  }
}

/** `p`, or a rejection once `ms` have passed without it. */
function within(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('unreached')), ms);
    p.then(
      () => (clearTimeout(timer), resolve()),
      (err) => (clearTimeout(timer), reject(err)),
    );
  });
}

/** Why the import could not be asked, kept short; the share waits either way. */
function failure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'functions/failed-precondition' || code === 'functions/invalid-argument') {
    return `Could not import it: ${message}. The share waits here.`;
  }
  return 'Could not reach Mossgoblin to import it; this needs a connection. The share waits here.';
}
