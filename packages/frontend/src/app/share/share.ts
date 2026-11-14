import {
  Component,
  DestroyRef,
  type ElementRef,
  InjectionToken,
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
import { MAX_PASTED_CHARS, type PastedImport, RECIPE_IMPORT_API } from '../kitchen/recipe-paste';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW, ONLINE } from '../platform/platform';
import { ReadingService } from '../reading/reading.service';
import { type PendingShare, SHARE_WORDS, ShareStore } from './share-store';
import {
  type RawShare,
  type Shared,
  openedHere,
  parseShare,
  shareKey,
  shareNoteText,
} from './shared';

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
      @if (view(); as v) {
        @if (v.s; as s) {
          <section class="shared" aria-label="What was shared">
            @if (s.title) {
              <p class="title">{{ s.title }}</p>
            }
            @if (s.words) {
              <p class="words">{{ preview(s.words) }}</p>
            }
            @if (s.link) {
              <p class="link">
                <a [href]="s.link" target="_blank" rel="noopener noreferrer"
                  >{{ s.link }}<span class="visually-hidden"> (opens in a new tab)</span></a
                >
              </p>
            }
          </section>
          @if (v.p.cut) {
            <p class="warn">
              Only the first {{ s.words.length.toLocaleString() }} of
              {{ v.p.cut.toLocaleString() }} characters came through: this share reached Mossgoblin
              before the app was ready on this device. Share it again to bring all of it.
            </p>
          }
        } @else if (v.state === 'loading') {
          <p class="muted">Reading back what was shared…</p>
        } @else if (v.state === 'missing') {
          <p class="warn">
            The words of this share were kept by the app, but cannot be read back now. Please share
            them again.
          </p>
        }
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
          <p class="muted">
            It is kept on this device, and can be filed as soon as your notes are here.
          </p>
        } @else if (elsewhere()) {
          <p class="muted">It is being filed in another Mossgoblin window.</p>
        } @else if (v.s && !v.s.link && !v.p.cut) {
          <p class="muted">Keeping it as a note…</p>
        } @else {
          <div class="actions" role="group" aria-label="File it">
            @if (v.s; as s) {
              @if (!s.words) {
                <button #first type="button" [disabled]="busy()" (click)="readLater(v)">
                  Save to read later
                </button>
                <button type="button" [disabled]="busy()" (click)="keepAsNote(v)">
                  Keep as a note
                </button>
                @if (modules.kitchen()) {
                  <button type="button" [disabled]="busy()" (click)="importLink(v)">
                    Import as a recipe
                  </button>
                }
              } @else {
                <button #first type="button" [disabled]="busy()" (click)="keepAsNote(v)">
                  Keep as a note
                </button>
                @if (s.link && modules.kitchen()) {
                  <button type="button" [disabled]="busy()" (click)="importFromText(v)">
                    Import as a recipe from this text
                  </button>
                }
              }
            }
            <button type="button" class="quiet" [disabled]="busy()" (click)="letGo(v)">
              Let it go
            </button>
          </div>
        }
        @if (waiting().length > 1) {
          <p class="muted">
            {{ waiting().length - 1 }} more
            {{ waiting().length === 2 ? 'share waits' : 'shares wait' }} after this one.
          </p>
        }
      } @else {
        <p class="muted">Nothing shared is waiting to be filed.</p>
      }
      <!-- In the page from the start, so its first message is announced. -->
      <p class="said" role="status">{{ said() }}</p>
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
      margin: 0;
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
  private readonly words = inject(SHARE_WORDS);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly isOnline = inject(ONLINE);
  private readonly now = inject(NOW);
  private readonly timing = inject(SHARE_TIMING);

  /** The shares the one signed in may see (theirs, and those that came signed out). */
  protected readonly waiting = computed(() => this.store.visibleTo(this.auth.user()?.uid));
  /** Words `sw.js` stashed, read back by id; null when they cannot be. */
  private readonly stashed = signal<Record<string, Omit<RawShare, 'at'> | null>>({});
  /**
   * The share shown, the newest waiting, so the one just shared comes
   * first, read from its fields as kept (review on #271: kept first,
   * read after).
   */
  protected readonly view = computed<ShareView | undefined>(() => {
    const p = this.waiting().at(-1);
    if (!p) return undefined;
    let fields: Omit<RawShare, 'at'> = p;
    if (p.stash) {
      const found = this.stashed()[p.stash];
      if (found === undefined) return { p, state: 'loading' };
      if (found === null) return { p, state: 'missing' };
      fields = found;
    }
    const s = parseShare({ ...fields, at: p.at });
    return s ? { p, s: { ...s, key: p.key }, state: 'ready' } : { p, state: 'empty' };
  });
  protected readonly busy = signal(false);
  protected readonly said = signal('');
  private readonly online = signal(this.isOnline());
  /** `ready` is a getter over signals, so this follows sign-in and the notes loading. */
  protected readonly notesReady = computed(() => !!this.auth.user() && this.notes.ready);
  /** Another window holds the share shown while it files it. */
  protected readonly elsewhere = computed(() => {
    const v = this.view();
    return !!v && this.store.heldElsewhere(v.p, this.now());
  });

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly first = viewChild<ElementRef<HTMLElement>>('first');

  constructor() {
    // Taken in first, as it came, before it is read and before anything
    // waits on auth or the network: the fields go into this device's
    // store (or, when long, stay where sw.js stashed them, kept by id),
    // then out of the address, so a reload neither loses nor files them
    // twice.
    const route = inject(ActivatedRoute);
    const doc = inject(DOCUMENT);
    const params = route.snapshot.queryParamMap;
    if (params.keys.length) {
      // Only from this device: another site's link must not plant words
      // a later Claude would read (review on #98).
      if (openedHere(doc.referrer, doc.location.origin)) {
        const stash = /^\d{1,16}$/.test(params.get('stash') ?? '') ? params.get('stash')! : '';
        const cut = Number(params.get('cut'));
        const raw: RawShare = {
          title: params.get('title') ?? '',
          text: params.get('text') ?? '',
          url: params.get('url') ?? '',
          at: params.get('at') ?? '',
          ...(Number.isSafeInteger(cut) && cut > 0 ? { cut } : {}),
        };
        if (!stash && !raw.title && !raw.text && !raw.url) {
          this.said.set('Nothing came with that share.');
        } else {
          const key = stash && !/^\d{1,16}$/.test(raw.at) ? `stash:${stash}` : shareKey(raw);
          const taken = this.store.take(
            { ...raw, key, ...(stash ? { stash } : {}) },
            { now: this.now(), uid: this.auth.user()?.uid },
          );
          if (!taken) this.said.set('That share has been filed already.');
        }
      }
      void this.router.navigate([], { relativeTo: route, queryParams: {}, replaceUrl: true });
    }

    // Stashed words are read back from the device's cache; nothing else.
    const asked = new Set<string>();
    effect(() => {
      const stash = this.waiting().at(-1)?.stash;
      if (!stash || asked.has(stash)) return;
      asked.add(stash);
      this.words
        .read(stash)
        .catch(() => undefined)
        .then((found) => this.stashed.update((m) => ({ ...m, [stash]: found ?? null })));
    });

    // A share that brought nothing to keep is let go, and says so.
    effect(() => {
      const v = this.view();
      if (v?.state !== 'empty') return;
      untracked(() => {
        this.store.done(v.p.key);
        this.said.set('Nothing came with that share.');
      });
    });

    // Words with no link have one way to go: a note, at once, as before
    // the landing step (#42, 2026-10-08), as soon as the notes are here
    // (signed out, the share waits above for sign-in).
    effect(() => {
      const v = this.view();
      if (!v?.s || v.s.link || !this.notesReady() || this.busy() || this.elsewhere()) return;
      // Words the Worker had to shorten wait for a tap, so the page can say so.
      if (v.p.cut) return;
      untracked(() => this.keepAsNote(v, { replaceUrl: true }));
    });

    // The recipe this share asked for is done (its answer may have been
    // lost, or the page reloaded while it was read): filed (review on
    // #271), and opened.
    effect(() => {
      const v = this.view();
      const id = v?.p.recipeId;
      if (!v || !id || !this.notesReady() || this.notes.find(id)?.importState !== 'done') return;
      untracked(() => {
        this.store.done(v.p.key);
        void this.router.navigate(['/n', id], { replaceUrl: true });
      });
    });

    // Focus on arrival, and on the next share once one is filed: its
    // first action, else the heading.
    const shown = computed(
      () => `${this.view()?.p.key}|${this.view()?.state}|${this.notesReady()}|${this.auth.user()}`,
    );
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
   * Claims the share for this window while it is filed; another window
   * holding it says so here instead.
   */
  private claim(v: ShareView, ms: number): boolean {
    if (this.busy() || !this.notesReady()) return false;
    if (this.store.claim(v.p.key, this.now(), ms)) return true;
    this.said.set('That share is being filed in another Mossgoblin window.');
    return false;
  }

  /** Filed another way: a recipe placeholder it made, still untouched, goes to Trash. */
  private dropRecipe(v: ShareView): void {
    if (v.p.recipeId && v.s?.link) this.notes.dropSharedRecipe(v.p.recipeId, v.s.link);
  }

  /**
   * As a share became a note before (#42): a new capture note holding
   * the words, the title and the link, written at once (kept until the
   * server has it, #200), and opened at `/`, where a share always
   * landed. Filed with no tap, the share page leaves history with it.
   */
  protected keepAsNote(v: ShareView, { replaceUrl = false } = {}): void {
    if (!v.s || !this.claim(v, CLAIM_MS)) return;
    this.capture.newNote();
    this.capture.replace(shareNoteText(v.s));
    this.capture.flush();
    this.dropRecipe(v);
    this.store.done(v.p.key);
    void this.router.navigate(['/'], { replaceUrl });
  }

  /** Into the reading queue (#48), offline too; its page is fetched on the server. */
  protected readLater(v: ShareView): void {
    if (!v.s || !this.claim(v, CLAIM_MS)) return;
    if (!this.reading.save(v.s.link)) {
      this.store.release(v.p.key);
      this.said.set('That link cannot be saved to read: it is not a web address.');
      return;
    }
    this.store.done(v.p.key);
    void this.router.navigate(['/reading']);
  }

  /** As Import from a link does (#128): the server reads the page, offline or not. */
  protected importLink(v: ShareView): void {
    if (!v.s || !this.claim(v, CLAIM_MS)) return;
    const id = this.notes.importRecipe(v.s.link);
    if (!id) {
      this.store.release(v.p.key);
      this.said.set('That link cannot be imported: it is not a web address.');
      return;
    }
    this.store.done(v.p.key);
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
  protected async importFromText(v: ShareView): Promise<void> {
    const s = v.s;
    if (!s || this.busy() || !this.notesReady()) return;
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
    if (!this.claim(v, CLAIM_IMPORT_MS)) return;
    const id = v.p.recipeId ?? this.notes.newId();
    if (!v.p.recipeId) this.store.update(v.p.key, { recipeId: id });
    const written = this.notes.sharedRecipe(s.link, id);
    if (!written) {
      this.store.release(v.p.key);
      this.said.set('That link cannot be imported: it is not a web address.');
      return;
    }
    this.busy.set(true);
    this.said.set(`Reading the recipe from what was shared from ${hostOf(s.link) || 'the page'}…`);
    let filed = false;
    const file = () => {
      filed = true;
      this.said.set('');
      this.store.done(v.p.key);
      void this.router.navigate(['/n', id]);
    };
    try {
      await within(written, this.timing.writeWaitMs);
      const result = await this.ask(id, s.words);
      if (result.state === 'done') return file();
      this.notes.importFailed(id, result.error);
      this.said.set(
        `Could not import it: ${result.error}. The recipe is kept with its link, and this ` +
          'share waits here, to keep as a note.',
      );
    } catch (err) {
      // Done on the server, its answer lost: the recipe is made.
      if (this.notes.find(id)?.importState === 'done') return file();
      this.said.set(failure(err));
    } finally {
      this.busy.set(false);
      if (!filed) this.store.release(v.p.key);
    }
  }

  /**
   * Asks for the import, again while the server says it has no such
   * recipe yet: after a reload, the recipe may be on this device and not
   * on the server, for a short while (review on #271).
   */
  private async ask(id: string, words: string): Promise<PastedImport> {
    const api = this.injector.get(RECIPE_IMPORT_API);
    const until = this.now() + this.timing.writeWaitMs;
    for (;;) {
      try {
        return await api.importPasted(id, words);
      } catch (err) {
        if (!notYetThere(err) || this.now() >= until) throw err;
        await new Promise((done) => setTimeout(done, this.timing.retryMs));
      }
    }
  }

  /** Not wanted after all: forgotten, and a recipe stub it made goes to Trash. */
  protected letGo(v: ShareView): void {
    if (this.busy()) return;
    // Signed out there is no stub to tidy and no other window to wait on.
    if (this.notesReady() && !this.claim(v, CLAIM_MS)) return;
    if (this.notesReady()) this.dropRecipe(v);
    this.store.done(v.p.key);
    this.said.set('Let go.');
  }
}

/** The share shown, as kept and as read. */
export interface ShareView {
  p: PendingShare;
  s?: Shared;
  /** `loading`: its stashed words are being read back; `missing`: they cannot be. */
  state: 'ready' | 'loading' | 'missing' | 'empty';
}

/** How long a window holds a share while it files it at once. */
const CLAIM_MS = 30_000;
/** And while a recipe import from its words runs (the call allows five minutes). */
const CLAIM_IMPORT_MS = 6 * 60_000;

/** Waits for the share page, as a seam for specs. */
export const SHARE_TIMING = new InjectionToken<{ writeWaitMs: number; retryMs: number }>(
  'share-timing',
  {
    providedIn: 'root',
    // The recipe's write reaching the server, then asking again for it.
    factory: () => ({ writeWaitMs: WRITE_WAIT_MS, retryMs: 2_000 }),
  },
);

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

const code = (err: unknown) => (err as { code?: unknown } | null)?.code;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The server has no such recipe: this device's write has not reached it yet. */
function notYetThere(err: unknown): boolean {
  return code(err) === 'functions/failed-precondition' && /^no recipe /.test(message(err));
}

/** Why the import could not be asked, kept short and true; the share waits either way. */
function failure(err: unknown): string {
  if (notYetThere(err)) {
    return (
      'The recipe has not reached Mossgoblin from this device yet; it will once this device ' +
      'syncs. Ask again in a moment. The share waits here.'
    );
  }
  if (code(err) === 'functions/failed-precondition' && /being read already/.test(message(err))) {
    return 'Mossgoblin is reading it already; the recipe opens here once that is done.';
  }
  if (code(err) === 'functions/failed-precondition' || code(err) === 'functions/invalid-argument') {
    return `Could not import it: ${message(err)}. The share waits here.`;
  }
  if (message(err) === 'unreached') {
    return (
      'The recipe has not reached Mossgoblin from this device yet; this needs a connection. ' +
      'The share waits here.'
    );
  }
  return 'Could not reach Mossgoblin to import it; this needs a connection. The share waits here.';
}
