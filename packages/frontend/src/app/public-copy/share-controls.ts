import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  InjectionToken,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { SHARE_PATH, paths } from '@mossgoblin/schema';
import { type Firestore, doc, onSnapshot } from 'firebase/firestore';
import { FIREBASE } from '../firebase';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import { ONLINE } from '../platform/platform';
import { type ShareCopy, sameCopy, shareCopyOf } from './share-copy';

/** A share's document as this device has it: its copy, or `gone` when there is none. */
export type SharedDoc = Partial<ShareCopy> | 'gone';

/** The Firestore read the controls make, as a seam for unit specs. */
export interface SharesApi {
  /**
   * Watches one share's document, through the persistent cache: its
   * fields, or `gone` once the server says it is not there.
   */
  watch(
    db: Firestore,
    path: string,
    next: (shared: SharedDoc) => void,
    error: (err: unknown) => void,
  ): () => void;
}

export const SHARES_API = new InjectionToken<SharesApi>('shares-api', {
  providedIn: 'root',
  factory: () => ({
    watch: (db, path, next, error) =>
      onSnapshot(
        doc(db, path),
        (snap) => {
          // Not in the cache yet is not gone: only the server says that.
          if (!snap.exists()) {
            if (!snap.metadata.fromCache) next('gone');
            return;
          }
          next(snap.data() as Partial<ShareCopy>);
        },
        // The rules let the owner read only a share that is there and
        // theirs: one deleted since is refused, and is gone.
        (err) =>
          (err as { code?: string }).code === 'permission-denied' ? next('gone') : error(err),
      ),
  }),
});

/** A share's public address on this origin. */
export function shareLink(origin: string, shareId: string): string {
  return `${origin}${SHARE_PATH}${shareId}`;
}

/**
 * A note's public copy, on the back of the note (2026-11-26, Eric;
 * DESIGN.md, Sharing a public copy): Share a copy, or, once shared, the
 * link with Copy link, Update the shared copy (offered once the note
 * says something the copy does not; never on its own) and Stop sharing.
 */
@Component({
  selector: 'app-share-controls',
  template: `
    <h3 id="share-heading">Share a copy</h3>
    @if (note().shareId; as id) {
      <p class="shared" role="status">
        <strong>Shared.</strong> Anyone with the link can read this copy of the title and text. It
        is not listed anywhere.
        @if (!online()) {
          It is saved on this device and the link works once it is back online.
        }
      </p>
      @if (gone()) {
        <p class="muted">The shared copy is not there any more; the link answers nothing.</p>
      } @else {
        <p class="link">
          <a
            [href]="link()"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="The shared link"
            >{{ link() }}</a
          >
        </p>
      }
      <div class="actions">
        @if (!gone()) {
          <button type="button" (click)="copy()">Copy link</button>
          <button type="button" [disabled]="!changed()" (click)="update()">
            Update the shared copy
          </button>
        }
        <button type="button" (click)="stop()">Stop sharing</button>
      </div>
      <p class="hint">
        @if (changed()) {
          The note has changed since it was shared; the copy shows it as it was.
        } @else {
          The copy shows the note as it is now. Later edits stay here until you update it.
        }
      </p>
    } @else {
      <p class="hint">
        A public copy of the title and text, at a link only people you send it to can find. Not its
        tags, links, history or anything else on this side.
      </p>
      @if (refusal(); as why) {
        <p class="muted">{{ why }}</p>
      } @else {
        <button type="button" (click)="share()">Share a copy</button>
      }
    }
    @if (said()) {
      <p role="status" class="said">{{ said() }}</p>
    }
  `,
  styles: `
    h3 {
      margin: var(--space-3) 0 var(--space-1);
      font-size: 14px;
      font-weight: 600;
      color: var(--quiet);
    }
    p {
      margin: var(--space-1) 0;
    }
    .muted,
    .hint {
      color: var(--quiet);
    }
    .hint {
      font-size: 13px;
    }
    .link a {
      color: var(--accent);
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin: var(--space-1) 0;
    }
    button {
      font: inherit;
      font-size: 14px;
      min-height: 36px;
      padding: 2px 12px;
      border-radius: var(--radius-pill);
      border: var(--border) solid var(--rule);
      color: var(--ink);
      background: var(--surface);
      cursor: pointer;
    }
    button:disabled {
      color: var(--quiet);
      cursor: default;
    }
  `,
})
export class ShareControls {
  readonly note = input.required<NoteRecord>();
  private readonly notes = inject(NotesService);
  private readonly api = inject(SHARES_API);
  private readonly fb = inject(FIREBASE);
  private readonly origin = inject(DOCUMENT).defaultView?.location.origin ?? '';
  private readonly isOnline = inject(ONLINE);
  protected readonly online = signal(this.isOnline());
  /** The share's document as this device has it, while the note is shared. */
  private readonly sharedDoc = signal<SharedDoc | undefined>(undefined);
  protected readonly said = signal('');

  protected readonly link = computed(() => shareLink(this.origin, this.note().shareId ?? ''));
  protected readonly gone = computed(() => this.sharedDoc() === 'gone');
  protected readonly refusal = computed(() => this.notes.shareRefusal(this.note().id));
  /** Whether the note says something its copy does not; unknown reads as changed. */
  protected readonly changed = computed(() => {
    const copy = shareCopyOf(this.note());
    const shared = this.sharedDoc();
    if (!copy || shared === 'gone') return false;
    return !sameCopy(copy, shared);
  });

  constructor() {
    const shareId = computed(() => this.note().shareId);
    effect((onCleanup) => {
      const id = shareId();
      untracked(() => this.sharedDoc.set(undefined));
      if (!id) return;
      onCleanup(
        this.api.watch(
          this.fb.db,
          paths.share(id),
          (shared) => this.sharedDoc.set(shared),
          (err) => console.error('share listener', err),
        ),
      );
    });
    // Another note opened here starts with nothing said.
    const noteId = computed(() => this.note().id);
    effect(() => {
      noteId();
      untracked(() => this.said.set(''));
    });
    const view = inject(DOCUMENT).defaultView;
    const onLine = () => this.online.set(this.isOnline());
    view?.addEventListener('online', onLine);
    view?.addEventListener('offline', onLine);
    inject(DestroyRef).onDestroy(() => {
      view?.removeEventListener('online', onLine);
      view?.removeEventListener('offline', onLine);
    });
  }

  protected share(): void {
    const id = this.notes.share(this.note().id);
    this.said.set(id ? '' : 'Could not share this note.');
  }

  protected update(): void {
    this.notes.updateShare(this.note().id);
    this.said.set('The shared copy now shows the note as it is.');
  }

  protected stop(): void {
    this.notes.stopShare(this.note().id);
    this.said.set('Stopped. The link answers nothing now; sharing again makes a new link.');
  }

  protected async copy(): Promise<void> {
    const url = this.link();
    try {
      await navigator.clipboard.writeText(url);
      this.said.set('Link copied.');
    } catch {
      this.said.set(`Could not copy; the link is ${url}`);
    }
  }
}
