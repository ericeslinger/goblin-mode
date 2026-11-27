import { DOCUMENT } from '@angular/common';
import {
  Component,
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
        @if (waiting()?.op === 'share') {
          It is saved on this device, and the link works once this device is back online.
        }
      </p>
      @if (gone()) {
        <p class="muted">
          This copy could not be read here. Stop sharing makes sure no copy stays public.
        </p>
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
      @if (stopping()) {
        <p class="stopping" role="status">
          <strong>Still public.</strong> Sharing is stopped on this device, but the copy stays
          public until this device is back online and the stop reaches the server.
        </p>
      } @else if (refusal(); as why) {
        <p class="muted">{{ why }}</p>
      } @else {
        <button type="button" (click)="share()">Share a copy</button>
      }
    }
    @if (message()) {
      <p role="status" class="said">{{ message() }}</p>
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
  /** The share's document as this device has it, while the note is shared. */
  private readonly sharedDoc = signal<SharedDoc | undefined>(undefined);
  protected readonly said = signal('');
  /** What was last done here, said by `message` as the server has it or not. */
  private readonly acted = signal<'update' | 'stop' | undefined>(undefined);
  /** This share's write the server does not have yet, if any (2026-11-26, review of #343). */
  protected readonly waiting = computed(() => {
    const id = this.note().shareId;
    const w = id ? this.notes.sharesWaiting()[id] : undefined;
    return w?.failed ? undefined : w;
  });
  /** A stop of this note's share the server does not have yet: the copy is still public. */
  protected readonly stopping = computed(() =>
    Object.values(this.notes.sharesWaiting()).some(
      (w) => w.op === 'stop' && w.noteId === this.note().id && !w.failed,
    ),
  );
  /**
   * The last write for this note the server refused (review of #343):
   * the cache has taken it back, so the note shows as it truly is, and
   * the page says the act did not happen.
   */
  protected readonly refused = computed(() => {
    // Only while it is still true of the note (review of #343): a share
    // or a stop made since from another device or window settles it.
    const shared = this.note().shareId !== undefined;
    const all = Object.values(this.notes.sharesWaiting()).filter(
      (w) => w.failed && w.noteId === this.note().id && (w.op === 'share' ? !shared : shared),
    );
    return all.sort((a, b) => b.at - a.at)[0];
  });
  /** What the last act did, never saying a copy is gone or changed before the server has it. */
  protected readonly message = computed(() => {
    const refused = this.refused();
    if (refused?.op === 'stop') {
      return 'Stopping did not reach the server: the copy is still public. Try Stop sharing again.';
    }
    if (refused?.op === 'share') return 'Sharing did not reach the server: nothing is public.';
    if (refused?.op === 'update') {
      return 'The update did not reach the server: the link still shows the copy as it was.';
    }
    const acted = this.acted();
    if (acted === 'update') {
      return this.waiting()?.op === 'update'
        ? 'The update is saved on this device. Until it reaches the server, the link still shows the copy as it was.'
        : 'The shared copy now shows the note as it is.';
    }
    if (acted === 'stop' && !this.stopping()) {
      return 'Stopped. The link answers nothing now; sharing again makes a new link.';
    }
    return this.said();
  });

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
    // A share the server does not have yet is not watched (2026-11-27):
    // the rules refuse a read of a share that is not there, so a
    // listener begun before the first write arrived was refused for
    // good, and the page said the copy could not be read (a full run
    // caught it). It is watched once the server has it.
    const unsent = computed(() => this.waiting()?.op === 'share');
    effect((onCleanup) => {
      const id = shareId();
      const wait = unsent();
      untracked(() => this.sharedDoc.set(undefined));
      if (!id || wait) return;
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
      untracked(() => {
        this.said.set('');
        this.acted.set(undefined);
      });
    });
  }

  protected share(): void {
    const id = this.notes.share(this.note().id);
    this.acted.set(undefined);
    this.said.set(id ? '' : 'Could not share this note.');
  }

  protected update(): void {
    this.said.set('');
    this.notes.updateShare(this.note().id);
    this.acted.set('update');
  }

  protected stop(): void {
    this.said.set('');
    this.notes.stopShare(this.note().id);
    this.acted.set('stop');
  }

  protected async copy(): Promise<void> {
    const url = this.link();
    try {
      await navigator.clipboard.writeText(url);
      this.acted.set(undefined);
      this.said.set('Link copied.');
    } catch {
      this.acted.set(undefined);
      this.said.set(`Could not copy; the link is ${url}`);
    }
  }
}
