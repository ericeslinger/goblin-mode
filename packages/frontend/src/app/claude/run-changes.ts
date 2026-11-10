import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import {
  type DiffLine,
  PUT_BACK_TOOL,
  REROUTE_TOOL,
  lineDiff,
  paths,
  textHash,
  textLines,
} from '@mossgoblin/schema';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { HISTORY_API, HISTORY_SHOWN, type VersionRecord, toVersion } from '../history/history';
import { type NoteRecord, NotesService } from '../notes/notes.service';
import type { RunRecord } from './activity';

/**
 * How far before its record a run's own note write can be stamped, as
 * Put back allows (`RUN_SLACK_MS`, functions `putback/plan.ts`).
 */
export const RUN_SLACK_MS = 5_000;

type Touched = RunRecord['notes'][number];

/**
 * Whether run `run` wrote the text of its `index`th note, so the diff
 * view has something to show: a merge's merged note and a link's note,
 * not their originals or targets; filing only where its record kept
 * the hash of the text it rewrote (`before.body`, #206); not an archive,
 * nor an update_note that changed no text. A note the run made counts.
 */
export function changesText(run: RunRecord, index: number): boolean {
  const t = run.notes[index];
  if (!t) return false;
  if (t.made) return true;
  switch (run.tool) {
    case 'merge_notes':
    case 'link_notes':
      return index === 0;
    case 'refile':
    case 'finish_queued':
    case REROUTE_TOOL:
      return typeof (t.before as Record<string, unknown> | undefined)?.['body'] === 'string';
    case 'archive_note':
      return false;
    case 'update_note':
      return /\btext\b/.test(run.summary);
    case PUT_BACK_TOOL:
    default:
      return true;
  }
}

/** One side of the view: a text and where it came from. */
export interface Side {
  body: string;
  /** When that text was written, for a version History kept. */
  at?: number;
  /** The note as it is now, not a kept version. */
  now: boolean;
}

/** The text before and after a run, or why one is missing (#241). */
export interface Sides {
  before?: Side;
  /** No before: the run made the note, or History has none from before it. */
  noBefore?: 'made' | 'unkept';
  /** The before was found by time, though the run named an exact text History lacks. */
  beforeApprox?: boolean;
  after?: Side;
  /** The after is not the run's own text: the next version kept, or the note since changed. */
  afterLater?: boolean;
}

type Written = {
  updatedAt?: number;
  updatedBy?: 'user' | 'claude';
  agent?: string;
};

/**
 * The text before run `run` wrote note `touched`, and after (#241,
 * step 5 of #154), from `versions` (History, any order) and `note` (as
 * it is now, if it is there). Before: the version whose `textHash` is
 * the one the run named (its record's `before.body`, or the note's own
 * `baseHash` while the run's write is still the last), else the latest
 * version written before the run that is not its own. After: the note
 * now, while nothing has written it since; else the run's own text if
 * History kept it, else the next version it kept, else the note now.
 */
export function runSides(
  run: Pick<RunRecord, 'at' | 'agent'>,
  touched: Touched,
  versions: readonly VersionRecord[],
  note: NoteRecord | undefined,
): Sides {
  const at = run.at ?? 0;
  const own = (w: Written) =>
    w.updatedBy === 'claude' &&
    w.agent === run.agent &&
    w.updatedAt !== undefined &&
    Math.abs(w.updatedAt - at) <= RUN_SLACK_MS;
  const stamped = versions.filter((v) => v.updatedAt !== undefined);
  const out: Sides = {};

  // Before.
  const recorded = (touched.before as Record<string, unknown> | undefined)?.['body'];
  const hash =
    typeof recorded === 'string' ? recorded : note && own(note) ? note.baseHash : undefined;
  if (touched.made) {
    out.noBefore = 'made';
  } else {
    const byHash = hash ? versions.find((v) => textHash(v.body) === hash) : undefined;
    const byTime = byHash
      ? undefined
      : stamped
          .filter((v) => v.updatedAt! <= at + RUN_SLACK_MS && !own(v))
          .sort((a, b) => b.updatedAt! - a.updatedAt!)[0];
    const found = byHash ?? byTime;
    if (found) {
      out.before = { body: found.body, at: found.updatedAt, now: false };
      if (byTime && hash) out.beforeApprox = true;
    } else if (
      versions.length === 0 &&
      note?.createdAt !== undefined &&
      note.createdAt >= at - RUN_SLACK_MS
    ) {
      out.noBefore = 'made';
    } else {
      out.noBefore = 'unkept';
    }
  }

  // After.
  if (note && (note.updatedAt === undefined || note.updatedAt <= at + RUN_SLACK_MS)) {
    out.after = { body: note.body, now: true };
    return out;
  }
  const later = stamped
    .filter((v) => v.updatedAt! >= at - RUN_SLACK_MS && (own(v) || v.updatedAt! > at))
    .sort((a, b) => Number(own(b)) - Number(own(a)) || a.updatedAt! - b.updatedAt!)[0];
  if (later) {
    out.after = { body: later.body, at: later.updatedAt, now: false };
    if (!own(later)) out.afterLater = true;
  } else if (note) {
    out.after = { body: note.body, now: true };
    out.afterLater = true;
  }
  return out;
}

const plain = (body: string): DiffLine[] => textLines(body).map((text) => ({ kind: 'kept', text }));

let seq = 0;

/**
 * Show changes (#241, step 5 of #154): under a run's note in What
 * assistants changed, the text before the run and after it, the
 * changed lines marked by colour and by a "+" or "−" with the word
 * said to a screen reader. Read only when opened, from History and the
 * note; read-only, so Put back stays the way to undo. Two columns from
 * 600px wide, one above the other below.
 */
@Component({
  selector: 'app-run-changes',
  template: `
    <button
      type="button"
      class="toggle"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="panelId"
      [attr.aria-label]="'Show changes: ' + title()"
      (click)="toggle()"
    >
      Show changes
    </button>
    @if (open()) {
      <section class="panel" [id]="panelId" [attr.aria-label]="'Changes to ' + title()">
        @if (error()) {
          <p role="status" class="muted">Could not read History: {{ error() }}</p>
        } @else if (!sides()) {
          <p role="status" class="muted">Loading the changes…</p>
        } @else {
          @let s = sides()!;
          @if (notes().length) {
            <div class="notes">
              @for (line of notes(); track line) {
                <p class="muted">{{ line }}</p>
              }
            </div>
          }
          <div class="sides">
            <div class="side" role="group" [attr.aria-labelledby]="panelId + '-before'">
              <h3 [id]="panelId + '-before'">Before</h3>
              @if (s.before) {
                <p class="muted from">{{ from(s.before) }}</p>
                <div class="text">
                  @for (l of beforeLines(); track $index) {
                    @if (l.kind === 'removed') {
                      <del class="line removed"
                        ><span class="mark" aria-hidden="true">−</span
                        ><span class="visually-hidden">Removed: </span>{{ l.text }}</del
                      >
                    } @else {
                      <span class="line"
                        ><span class="mark" aria-hidden="true"></span>{{ l.text }}</span
                      >
                    }
                  } @empty {
                    <span class="muted">Empty.</span>
                  }
                </div>
              } @else if (s.noBefore === 'made') {
                <p class="muted from">New in this run.</p>
              } @else {
                <p class="muted from">History has no version from before this run.</p>
              }
            </div>
            <div class="side" role="group" [attr.aria-labelledby]="panelId + '-after'">
              <h3 [id]="panelId + '-after'">After</h3>
              @if (s.after) {
                <p class="muted from">{{ from(s.after) }}</p>
                <div class="text">
                  @for (l of afterLines(); track $index) {
                    @if (l.kind === 'added') {
                      <ins class="line added"
                        ><span class="mark" aria-hidden="true">+</span
                        ><span class="visually-hidden">Added: </span>{{ l.text }}</ins
                      >
                    } @else {
                      <span class="line"
                        ><span class="mark" aria-hidden="true"></span>{{ l.text }}</span
                      >
                    }
                  } @empty {
                    <span class="muted">Empty.</span>
                  }
                </div>
              } @else {
                <p class="muted from">This note is gone, and History kept nothing after it.</p>
              }
            </div>
          </div>
        }
      </section>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .toggle {
      font: inherit;
      font-size: 14px;
      padding: 0;
      border: 0;
      background: none;
      color: var(--accent);
      text-decoration: underline;
      cursor: pointer;
    }
    .panel {
      flex: 1 0 100%;
      margin: var(--space-1) 0 var(--space-2);
      animation: open var(--motion) ease-out;
    }
    @keyframes open {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .panel {
        animation: none;
      }
    }
    .notes p {
      margin: 0 0 var(--space-1);
    }
    .sides {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-3);
    }
    @media (min-width: 600px) {
      .sides {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }
    }
    h3 {
      font-size: 14px;
      margin: 0;
    }
    .from {
      margin: 0 0 var(--space-1);
    }
    .text {
      display: flex;
      flex-direction: column;
      font-family: var(--font-mono);
      font-size: 13px;
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      background: var(--surface);
      padding: var(--space-1) 0;
    }
    .line {
      display: block;
      min-height: 1.4em;
      padding: 0 var(--space-2) 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      text-decoration: none;
      color: var(--ink);
    }
    .mark {
      display: inline-block;
      width: 2ch;
      text-align: center;
      font-weight: 700;
    }
    .added {
      background: color-mix(in srgb, var(--good) 20%, var(--surface));
    }
    .removed {
      background: color-mix(in srgb, var(--accent) 14%, var(--surface));
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
  `,
})
export class RunChanges {
  readonly run = input.required<RunRecord>();
  readonly note = input.required<Touched>();
  /** The note's title as the page shows it. */
  readonly title = input.required<string>();

  private readonly api = inject(HISTORY_API);
  private readonly fb = inject(FIREBASE);
  private readonly auth = inject(AuthService);
  private readonly notesService = inject(NotesService);

  protected readonly panelId = `run-changes-${++seq}`;
  protected readonly open = signal(false);
  private readonly versions = signal<VersionRecord[] | undefined>(undefined);
  protected readonly error = signal('');
  private stop: (() => void) | undefined;

  protected readonly sides = computed(() => {
    const versions = this.versions();
    if (!versions) return undefined;
    const id = this.note().id;
    const note = this.notesService.find(id);
    return runSides(this.run(), this.note(), versions, note);
  });

  private readonly diff = computed(() => {
    const s = this.sides();
    return s?.before && s.after ? lineDiff(s.before.body, s.after.body) : undefined;
  });

  protected readonly beforeLines = computed(() => {
    const d = this.diff();
    if (d) return d.lines.filter((l) => l.kind !== 'added');
    return plain(this.sides()?.before?.body ?? '');
  });

  protected readonly afterLines = computed(() => {
    const d = this.diff();
    if (d) return d.lines.filter((l) => l.kind !== 'removed');
    const s = this.sides();
    // A note the run made is all added; with no before kept, nothing is marked.
    const lines = plain(s?.after?.body ?? '');
    return s?.noBefore === 'made'
      ? lines.map((l): DiffLine => ({ kind: 'added', text: l.text }))
      : lines;
  });

  /** What the view says about what it found, above the two sides. */
  protected readonly notes = computed(() => {
    const s = this.sides();
    if (!s) return [];
    const out: string[] = [];
    const d = this.diff();
    if (d && d.lines.every((l) => l.kind === 'kept')) out.push('The text did not change.');
    if (d?.capped)
      out.push('Too long to compare line by line: the changed part is shown whole on each side.');
    if (s.beforeApprox)
      out.push(
        'History has no copy of the exact text before; this is the version it kept just before the run.',
      );
    if (s.noBefore === 'unkept' && (this.versions()?.length ?? 0) >= HISTORY_SHOWN)
      out.push(`History here reads its latest ${HISTORY_SHOWN} versions; open History for more.`);
    if (s.afterLater)
      out.push(
        s.after?.now
          ? 'The note has changed since; this is how it reads now.'
          : 'History did not keep this run’s own text; this is the next version it kept.',
      );
    return out;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }

  protected toggle(): void {
    if (this.open()) {
      this.open.set(false);
      this.stop?.();
      this.stop = undefined;
      return;
    }
    this.open.set(true);
    this.load();
  }

  private load(): void {
    const uid = this.auth.user()?.uid;
    this.error.set('');
    this.versions.set(undefined);
    if (!uid) {
      this.error.set('not signed in');
      return;
    }
    this.stop = this.api.listen(
      this.fb.db,
      paths.history(uid, this.note().id),
      (docs) => this.versions.set(docs.map((d) => toVersion(d.id, d.data))),
      (err) => this.error.set((err as Error).message || 'unknown error'),
    );
  }

  protected from(side: Side): string {
    if (side.now) return 'The note now';
    if (side.at === undefined) return 'Kept in History';
    const when = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(side.at);
    return `Kept in History, written ${when}`;
  }
}
