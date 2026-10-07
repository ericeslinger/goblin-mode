import { Component, DestroyRef, InjectionToken, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { paths } from '@mossgoblin/schema';
import { type Firestore, collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NotesService } from '../notes/notes.service';
import { ProposalsService } from './proposals.service';

/** A Claude run as What Claude changed lists it; times in milliseconds. */
export interface RunRecord {
  id: string;
  at?: number;
  summary: string;
  notes: { id: string; title: string }[];
  reminders: { id: string; title: string }[];
}

/** The Firestore read the page makes, as a seam for unit specs. */
export interface ActivityApi {
  /** The latest runs, newest first. */
  listen(
    db: Firestore,
    path: string,
    next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    error: (err: unknown) => void,
  ): () => void;
}

/** How many runs the page shows; older ones stay stored. */
export const RUNS_SHOWN = 100;

export const ACTIVITY_API = new InjectionToken<ActivityApi>('activity-api', {
  providedIn: 'root',
  factory: () => ({
    listen: (db, path, next, error) =>
      onSnapshot(
        query(collection(db, path), orderBy('at', 'desc'), limit(RUNS_SHOWN)),
        (snap) => next(snap.docs.map((d) => ({ id: d.id, data: d.data() }))),
        error,
      ),
  }),
});

const millis = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.();

const touched = (v: unknown) =>
  Array.isArray(v)
    ? v.map((t: { id?: unknown; title?: unknown }) => ({
        id: String(t.id ?? ''),
        title: String(t.title ?? ''),
      }))
    : [];

function toRun(id: string, data: Record<string, unknown>): RunRecord {
  return {
    id,
    at: millis(data['at']),
    summary: String(data['summary'] ?? ''),
    notes: touched(data['notes']),
    reminders: touched(data['reminders']),
  };
}

/**
 * What Claude changed (#34): every run of a Claude tool that wrote
 * something, newest first, each linking the notes it touched and their
 * History, so any change can be read and put back. Above it, the nightly
 * run's suggestions (#35), to accept or dismiss.
 */
@Component({
  selector: 'app-activity',
  imports: [RouterLink],
  template: `
    <main class="page">
      <a routerLink="/">Back</a>
      <h1>What Claude changed</h1>
      @if (proposals.shown().length) {
        <section aria-labelledby="suggestions">
          <h2 id="suggestions">Suggestions</h2>
          <p class="muted">
            From last night's look through your notes. Nothing changes until you accept.
          </p>
          <ul aria-label="Suggestions" class="suggestions">
            @for (p of proposals.shown(); track p.id) {
              <li>
                <p class="what" [id]="'proposal-' + p.id">
                  @switch (p.kind) {
                    @case ('link') {
                      Link <a [routerLink]="['/n', p.notes[0].id]">{{ title(p.notes[0]) }}</a> to
                      @for (n of p.notes.slice(1); track n.id; let last = $last) {
                        <a [routerLink]="['/n', n.id]">{{ title(n) }}</a
                        >{{ last ? '' : ', ' }}
                      }
                    }
                    @case ('merge') {
                      Merge
                      @for (n of p.notes; track n.id; let last = $last) {
                        <a [routerLink]="['/n', n.id]">{{ title(n) }}</a
                        >{{ last ? '' : ', ' }}
                      }
                      into one note{{ p.title ? ' titled ' + p.title : '' }}
                    }
                    @case ('refile') {
                      {{ p.conceptType ? 'File' : 'Give' }}
                      <a [routerLink]="['/n', p.notes[0].id]">{{ title(p.notes[0]) }}</a>
                      @if (p.conceptType) {
                        as {{ p.conceptType === 'other' ? 'a concept' : 'a ' + p.conceptType }}
                      }
                      @if (p.synonyms?.length) {
                        {{ p.conceptType ? 'and call it' : 'the other names' }}
                        {{ p.synonyms!.join(', ') }}
                      }
                    }
                  }
                </p>
                <p class="muted">{{ p.reason }}</p>
                @switch (p.status) {
                  @case ('open') {
                    <div class="actions">
                      <button
                        type="button"
                        class="primary"
                        [attr.aria-describedby]="'proposal-' + p.id"
                        (click)="proposals.accept(p.id)"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        [attr.aria-describedby]="'proposal-' + p.id"
                        (click)="proposals.dismiss(p.id)"
                      >
                        Dismiss
                      </button>
                    </div>
                  }
                  @case ('failed') {
                    <p role="status">Could not do this: {{ p.outcome }}</p>
                  }
                  @default {
                    <p role="status">Accepted. Claude is on it.</p>
                  }
                }
              </li>
            }
          </ul>
        </section>
        <h2>Changes</h2>
      }
      @if (!loaded()) {
        <p class="muted" role="status">Loading…</p>
      } @else if (runs().length === 0) {
        <p class="muted">
          Nothing yet. When Claude writes, links, splits, merges, refiles or archives a note, it
          shows here.
        </p>
      } @else {
        <ul aria-label="Changes" class="runs">
          @for (run of runs(); track run.id) {
            <li>
              <p class="summary">
                <span class="when">{{ when(run) }}</span> {{ run.summary }}
              </p>
              @if (run.notes.length) {
                <ul class="touched" [attr.aria-label]="'Notes: ' + run.summary">
                  @for (n of run.notes; track n.id) {
                    <li>
                      <a [routerLink]="['/n', n.id]">{{ title(n) }}</a>
                      @if (archived(n.id)) {
                        <span class="muted">archived</span>
                      }
                      <a routerLink="/history" [queryParams]="{ note: n.id }" class="muted"
                        >History<span class="visually-hidden"> of {{ title(n) }}</span></a
                      >
                    </li>
                  }
                </ul>
              }
              @if (run.reminders.length) {
                <ul class="touched" [attr.aria-label]="'Reminders: ' + run.summary">
                  @for (r of run.reminders; track r.id) {
                    <li>
                      <a routerLink="/right-now">{{ r.title }}</a>
                    </li>
                  }
                </ul>
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
    .suggestions > li {
      padding: var(--space-2) 0;
      border-bottom: var(--border) solid var(--rule);
    }
    .what,
    .suggestions p {
      margin: 0 0 var(--space-1);
    }
    .actions {
      display: flex;
      gap: var(--space-2);
    }
    .actions button {
      font: inherit;
      padding: 6px 16px;
      border-radius: var(--radius-pill);
      border: var(--border) solid var(--rule);
      color: var(--ink);
      background: var(--surface);
      cursor: pointer;
    }
    .actions .primary {
      border-color: var(--accent);
      color: var(--on-accent);
      background: var(--accent);
    }
    .runs > li {
      padding: var(--space-2) 0;
      border-bottom: var(--border) solid var(--rule);
    }
    .summary {
      margin: 0 0 var(--space-1);
    }
    .when {
      font-weight: 600;
      margin-right: var(--space-1);
    }
    .touched li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      padding: 2px 0;
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
  `,
})
export class Activity {
  private readonly api = inject(ACTIVITY_API);
  private readonly fb = inject(FIREBASE);
  private readonly auth = inject(AuthService);
  private readonly notes = inject(NotesService);
  protected readonly proposals = inject(ProposalsService);

  protected readonly runs = signal<RunRecord[]>([]);
  protected readonly loaded = signal(false);

  constructor() {
    let stop: (() => void) | undefined;
    effect(() => {
      const uid = this.auth.user()?.uid;
      stop?.();
      stop = undefined;
      this.runs.set([]);
      this.loaded.set(false);
      if (!uid) return;
      stop = this.api.listen(
        this.fb.db,
        paths.activity(uid),
        (docs) => {
          this.runs.set(docs.map((d) => toRun(d.id, d.data)));
          this.loaded.set(true);
        },
        (err) => console.error('activity listener', err),
      );
    });
    inject(DestroyRef).onDestroy(() => stop?.());
  }

  /** The note's title now, or as it was when Claude touched it. */
  protected title(n: { id: string; title: string }): string {
    return this.notes.find(n.id)?.title || n.title || 'Untitled';
  }

  protected archived(id: string): boolean {
    return this.notes.find(id)?.archived === true;
  }

  protected when(run: RunRecord): string {
    if (run.at === undefined) return '';
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(run.at);
  }
}
