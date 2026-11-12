import {
  Component,
  DestroyRef,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { type DataKey, type KeepReason, agentOf, isSealed, paths } from '@mossgoblin/schema';
import { type Firestore, collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { CaptureService } from '../capture/capture.service';
import { FIREBASE } from '../firebase';
import { NoteKeyService } from '../notes/note-key.service';
import { NotesService, openField } from '../notes/notes.service';
import { HomeLink } from '../home/home-link';

/** A kept version as History lists it; times in milliseconds. */
export interface VersionRecord {
  id: string;
  body: string;
  updatedBy: 'user' | 'claude';
  /** Which assistant, when updatedBy is claude (#142). */
  agent: string;
  reason: KeepReason;
  updatedAt?: number;
  savedAt?: number;
  /**
   * Sealed, and this device cannot open it yet (note encryption step
   * 3a): `body` is then '', never the sealed text, and it cannot be
   * restored.
   */
  locked?: true;
}

/** The Firestore read History makes, as a seam for unit specs. */
export interface HistoryApi {
  /** A note's kept versions, newest first. */
  listen(
    db: Firestore,
    path: string,
    next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    error: (err: unknown) => void,
  ): () => void;
}

/** How many versions History shows; older ones stay stored. */
export const HISTORY_SHOWN = 50;

export const HISTORY_API = new InjectionToken<HistoryApi>('history-api', {
  providedIn: 'root',
  factory: () => ({
    listen: (db, path, next, error) =>
      onSnapshot(
        query(collection(db, path), orderBy('savedAt', 'desc'), limit(HISTORY_SHOWN)),
        (snap) => next(snap.docs.map((d) => ({ id: d.id, data: d.data() }))),
        error,
      ),
  }),
});

const millis = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.();

/**
 * A kept version as History shows it. Its body is a copy of the note's,
 * so a sealed one opens as the note's own does (step 3a): `open` is
 * handed the sealed value and gives its text, or undefined.
 */
export function toVersion(
  id: string,
  data: Record<string, unknown>,
  open: (value: string) => string | undefined = () => undefined,
): VersionRecord {
  const stored = String(data['body'] ?? '');
  const body = isSealed(stored) ? open(stored) : stored;
  return {
    id,
    body: body ?? '',
    ...(body === undefined ? { locked: true as const } : {}),
    updatedBy: data['updatedBy'] === 'claude' ? 'claude' : 'user',
    agent: agentOf(data),
    reason: (data['reason'] as KeepReason) ?? 'interval',
    updatedAt: millis(data['updatedAt']),
    savedAt: millis(data['savedAt']),
  };
}

/** Why a version was kept, in Eric's words. */
export function reasonLabel(v: VersionRecord): string {
  switch (v.reason) {
    case 'device':
      return 'Written over from another device';
    case 'author':
      return v.updatedBy === 'claude'
        ? `${v.agent}'s version, before your edit`
        : 'Before an assistant edited it';
    case 'deleted':
      return 'Before the note was deleted';
    default:
      return 'Kept while editing';
  }
}

/**
 * A note's History (DESIGN.md, Conflicts): the versions noteHistory
 * kept, newest first. Open one to read it whole and put it back.
 */
@Component({
  selector: 'app-history',
  imports: [HomeLink],
  template: `
    <main class="page">
      <app-home-link />
      <h1>History</h1>
      @if (title()) {
        <p class="muted">{{ title() }}</p>
      }
      @if (versions().length === 0) {
        <p class="muted">
          No earlier versions yet. One is kept when another device or Claude writes over this note,
          and every ten minutes while you edit it.
        </p>
      } @else {
        <ul aria-label="Earlier versions">
          @for (v of versions(); track v.id) {
            <li>
              <button
                type="button"
                class="version"
                [attr.aria-expanded]="openId() === v.id"
                [attr.aria-controls]="'version-' + v.id"
                (click)="openId.set(openId() === v.id ? null : v.id)"
              >
                <span class="when">{{ when(v) }}</span>
                <span class="why">{{ label(v) }}</span>
                <span class="snippet">{{ v.locked ? 'Sealed' : snippet(v.body) }}</span>
              </button>
              @if (openId() === v.id) {
                <div [id]="'version-' + v.id" class="open">
                  @if (v.locked) {
                    <p class="muted">
                      This version is sealed, and its key is not on this device yet. It will open
                      when this device is back online and signed in.
                    </p>
                  } @else {
                    <pre class="body">{{ v.body }}</pre>
                    <button type="button" class="primary" (click)="restore(v)">
                      Restore this version
                    </button>
                  }
                </div>
              }
            </li>
          }
        </ul>
      }
    </main>
  `,
  styles: `
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      border-bottom: 1px solid var(--rule);
    }
    .version {
      display: block;
      width: 100%;
      padding: 10px 0;
      font: inherit;
      text-align: left;
      color: var(--ink);
      background: none;
      border: 0;
      cursor: pointer;
    }
    .when {
      font-weight: 600;
    }
    .why,
    .muted {
      color: var(--quiet);
    }
    .why {
      margin-left: 8px;
      font-size: 14px;
    }
    .snippet {
      display: block;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: var(--quiet);
    }
    .open {
      padding: 0 0 12px;
    }
    .body {
      margin: 0 0 12px;
      padding: 12px;
      white-space: pre-wrap;
      font: inherit;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      background: var(--surface);
    }
    .primary {
      font: inherit;
      padding: 6px 16px;
      border: 0;
      border-radius: var(--radius-pill);
      color: var(--on-accent);
      background: var(--accent);
      cursor: pointer;
    }
  `,
})
export class History {
  private readonly api = inject(HISTORY_API);
  private readonly fb = inject(FIREBASE);
  private readonly auth = inject(AuthService);
  private readonly notes = inject(NotesService);
  private readonly keys = inject(NoteKeyService);
  private readonly capture = inject(CaptureService);
  private readonly router = inject(Router);

  protected readonly noteId = signal('');
  /**
   * The versions as stored, and whose; shown opened with the key, so a
   * key that arrives later opens them then (step 3a).
   */
  private readonly docs = signal<
    { uid: string; id: string; docs: { id: string; data: Record<string, unknown> }[] } | undefined
  >(undefined);
  protected readonly versions = computed<VersionRecord[]>(() => {
    const kept = this.docs();
    if (!kept) return [];
    let key: DataKey | undefined;
    let read = false;
    // The key is read only for a sealed version.
    const open = (value: string) => {
      if (!read) [key, read] = [this.keys.key(), true];
      return openField(key, kept.uid, kept.id, 'body', value);
    };
    return kept.docs.map((d) => toVersion(d.id, d.data, open));
  });
  protected readonly openId = signal<string | null>(null);
  /** A note in Trash keeps its History (#217). */
  protected readonly title = computed(
    () => (this.notes.find(this.noteId()) ?? this.notes.trashed(this.noteId()))?.title ?? '',
  );
  protected readonly label = reasonLabel;

  constructor() {
    inject(ActivatedRoute)
      .queryParamMap.pipe(takeUntilDestroyed())
      .subscribe((params) => this.noteId.set(params.get('note') ?? ''));

    let stop: (() => void) | undefined;
    effect(() => {
      const uid = this.auth.user()?.uid;
      const id = this.noteId();
      stop?.();
      stop = undefined;
      this.docs.set(undefined);
      if (!uid || !id) return;
      stop = this.api.listen(
        this.fb.db,
        paths.history(uid, id),
        (docs) => this.docs.set({ uid, id, docs }),
        (err) => console.error('history listener', err),
      );
    });
    inject(DestroyRef).onDestroy(() => stop?.());
  }

  protected when(v: VersionRecord): string {
    const at = v.updatedAt ?? v.savedAt;
    if (at === undefined) return '';
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(at);
  }

  protected snippet(body: string): string {
    return body.replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  protected restore(v: VersionRecord): void {
    if (v.locked) return;
    this.capture.restore(this.noteId(), v.body);
    void this.router.navigate(['/n', this.noteId()]);
  }
}
