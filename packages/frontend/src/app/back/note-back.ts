import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { RUN_STALE_MS, madeLine, normalizeName, paths, templateParts } from '@mossgoblin/schema';
import { RunsService, type RunView } from '../agent/runs.service';
import { AuthService } from '../auth.service';
import { KeysService } from '../keys/keys.service';
import { ACTIVITY_API, putBackState, toRun, type RunRecord } from '../claude/activity';
import { PutBack } from '../claude/put-back';
import { FIREBASE } from '../firebase';
import { ConceptHeader } from '../links/concept-header';
import { NoteLinks } from '../links/note-links';
import { ModulesService } from '../modules/modules.service';
import { SAVE_DELAY_MS } from '../capture/capture.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';

/** "Oct 17, 9:05 PM", in the device's own words. */
function stamp(ms: number | undefined): string {
  if (ms === undefined) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(ms);
}

/**
 * The back of a note (#112, Eric 2026-10-17): what is about the note
 * rather than in it. When it was made and last edited, and by whom; what
 * Claude changed on it; the notes linking here; a concept's or a
 * template's settings, a template's Instructions for Claude (#111)
 * among them; its tags, History and Map. The front keeps the text.
 */
@Component({
  selector: 'app-note-back',
  imports: [ConceptHeader, NoteLinks, PutBack, RouterLink],
  template: `
    <section class="back" aria-label="Back of the note">
      <h2 class="title">{{ note().title || 'Untitled' }}</h2>
      <p class="times">
        @if (note().createdAt !== undefined) {
          <span>Made {{ madeAt() }}</span>
        }
        @if (note().updatedAt !== undefined) {
          <span>Edited {{ edited() }} {{ by() }}</span>
        }
      </p>

      @if (note().kind === 'recipe' && modules.kitchen()) {
        <div class="settings">
          <p class="made">{{ made() || 'Not made from a meal plan yet.' }}</p>
          <label class="inline">
            Serves
            <input
              #servings
              type="number"
              min="1"
              inputmode="numeric"
              [value]="note().servings ?? ''"
              (change)="setServings(servings.value)"
            />
          </label>
          <label class="instructions">
            Source
            <input
              #url
              type="url"
              placeholder="A link to the recipe"
              [value]="note().source?.url ?? ''"
              (change)="notes.updateRecipe(note().id, { url: url.value })"
            />
          </label>
          @if (note().source?.url; as link) {
            <a [href]="link" target="_blank" rel="noopener noreferrer">Open the source</a>
          }
          @if (note().source?.text; as original) {
            <details>
              <summary>The original text</summary>
              <p class="original">{{ original }}</p>
            </details>
          }
        </div>
      } @else if (note().kind === 'concept') {
        <app-concept-header side="back" [note]="note()" />
      } @else if (note().kind === 'template') {
        <div class="settings">
          <label>
            Each use
            <select #mode (change)="setMode(mode.value)">
              <option value="entry" [selected]="note().templateMode !== 'living'">
                makes a new note
              </option>
              <option value="living" [selected]="note().templateMode === 'living'">
                opens the same note
              </option>
            </select>
          </label>
          <label class="instructions">
            Instructions for Claude
            <!--
              Kept on the device as typed, written after a pause, and at once
              on leaving the field or the page (#200). Its value is set by
              the class, never over typing.
            -->
            <textarea
              #instructions
              rows="5"
              (input)="typeInstructions(instructions.value)"
              (change)="leaveInstructions(instructions.value)"
            ></textarea>
          </label>
          <p class="hint">
            How Claude fills in or tidies notes made from this template. Notes start from the
            front's text, without these.
          </p>
        </div>
      }

      <h3 id="send-to">Send to an assistant</h3>
      @if (note().sendState === 'queued') {
        @if (run(); as r) {
          <p role="status" class="run">
            @switch (r.status) {
              @case ('working') {
                @if (stale()) {
                  The run seems lost after {{ r.steps }} {{ r.steps === 1 ? 'step' : 'steps' }}; try
                  again.
                } @else {
                  Doing it now: {{ r.steps }} {{ r.steps === 1 ? 'step' : 'steps' }} so far.
                }
              }
              @case ('failed') {
                Could not do it now: {{ r.error || r.outcome }}
              }
              @case ('done') {
                Done: {{ r.outcome }}
              }
              @default {
                Starting…
              }
            }
          </p>
        } @else {
          <p role="status">
            Waiting for your assistant since {{ sentAt() }}
            @if (note().sendAsk; as ask) {
              : “{{ ask }}”
            }
            .
          </p>
        }
        <div class="actions">
          @if (canRunNow()) {
            <button type="button" [disabled]="starting()" (click)="doItNow()">Do it now</button>
          }
          <button type="button" class="link" (click)="notes.unsend(note().id)">Take it back</button>
        </div>
        @if (runStatus()) {
          <p role="status">{{ runStatus() }}</p>
        }
      } @else {
        @if (note().sendState === 'done') {
          <p role="status" class="done">
            Done: {{ note().sendOutcome }}
            <button type="button" class="link" (click)="notes.unsend(note().id)">Clear</button>
          </p>
        }
        <form class="send" (submit)="send($event, ask)">
          <label class="instructions">
            What should it do?
            <input
              #ask
              type="text"
              maxlength="500"
              placeholder="Optional: with nothing, it files the note"
            />
          </label>
          <button type="submit">Send</button>
        </form>
        <p class="hint">
          Your assistant picks it up the next time it checks; Settings, AI assistants, says how to
          set that up.
        </p>
      }

      <h3 id="claude-changes">What assistants changed</h3>
      @if (!loaded()) {
        <p class="muted" role="status">Loading…</p>
      } @else if (changes().length === 0) {
        <p class="muted">No assistant changed this note lately.</p>
      } @else {
        <ul aria-labelledby="claude-changes" class="changes">
          @for (run of changes(); track run.id) {
            <li>
              <span class="when">{{ when(run) }}</span> {{ run.summary }}
              @let state = putBack()(run);
              @if (state !== 'none') {
                <app-put-back [run]="run" [done]="state === 'done'" />
              }
            </li>
          }
        </ul>
      }
      <a routerLink="/activity" class="quiet-link">All assistants’ changes</a>

      <app-note-links
        [noteId]="note().id"
        [concept]="note().kind === 'concept'"
        empty="Nothing links here yet."
      />

      @if (note().tags?.length) {
        <h3 id="note-tags">Tags</h3>
        <ul aria-labelledby="note-tags" class="chips">
          @for (t of note().tags; track t) {
            <li>{{ t }}</li>
          }
        </ul>
      }

      <p class="more-links">
        <a routerLink="/history" [queryParams]="{ note: note().id }">History</a>
        <a [routerLink]="['/map/n', note().id]">Map</a>
      </p>
    </section>
  `,
  styles: `
    :host {
      display: block;
      overflow: auto;
    }
    .back {
      padding: var(--space-2) var(--space-3) var(--space-3);
      font-size: 14px;
    }
    .title {
      margin: var(--space-1) 0;
      font-family: var(--font-heading);
      font-size: 1.4em;
    }
    .times {
      display: flex;
      flex-wrap: wrap;
      gap: 0 var(--space-3);
      margin: 0 0 var(--space-2);
      color: var(--quiet);
    }
    h3 {
      margin: var(--space-3) 0 var(--space-1);
      font-size: 14px;
      font-weight: 600;
      color: var(--quiet);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .changes li {
      padding: var(--space-1) 0;
      border-bottom: 1px solid var(--rule);
    }
    .when,
    .muted,
    .hint {
      color: var(--quiet);
    }
    .hint {
      margin: var(--space-1) 0 0;
      font-size: 13px;
    }
    .settings {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-1) 0;
    }
    .instructions {
      display: grid;
      gap: var(--space-1);
    }
    .inline {
      display: flex;
      gap: var(--space-2);
      align-items: center;
    }
    .inline input {
      width: 5em;
    }
    .send {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: end;
    }
    .send label {
      flex: 1 1 12em;
    }
    .actions {
      display: flex;
      gap: var(--space-3);
      align-items: center;
    }
    .link {
      border: 0;
      padding: 0;
      font: inherit;
      color: var(--accent);
      background: none;
      cursor: pointer;
    }
    .original {
      white-space: pre-wrap;
      color: var(--quiet);
    }
    input,
    select,
    textarea {
      font: inherit;
      color: var(--ink);
      background: var(--surface);
      border: var(--border) solid var(--rule);
      border-radius: var(--radius-control);
      padding: var(--space-1) var(--space-2);
    }
    textarea {
      resize: vertical;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
    }
    .chips li {
      padding: 2px var(--space-2);
      border-radius: var(--radius-pill);
      background: var(--chip-bg);
    }
    a {
      color: var(--accent);
    }
    .quiet-link {
      display: inline-block;
      margin-top: var(--space-1);
    }
    .more-links {
      display: flex;
      gap: var(--space-3);
      margin: var(--space-3) 0 0;
    }
    app-note-links {
      padding: 0;
    }
  `,
})
export class NoteBack {
  readonly note = input.required<NoteRecord>();
  protected readonly notes = inject(NotesService);
  /** Kitchen off, a recipe is a plain note (review on #135). */
  protected readonly modules = inject(ModulesService);
  private readonly api = inject(ACTIVITY_API);
  private readonly fb = inject(FIREBASE);
  private readonly auth = inject(AuthService);

  /** The latest runs (the last hundred, as What assistants changed shows). */
  private readonly runs = signal<RunRecord[]>([]);
  protected readonly loaded = signal(false);
  /** The runs that touched this note, newest first. */
  protected readonly changes = computed(() =>
    this.runs().filter((r) => r.notes.some((n) => n.id === this.note().id)),
  );
  /** Put back (#154 step 1), judged against every run listed, not only this note's. */
  protected readonly putBack = computed(() => putBackState(this.runs()));

  protected readonly madeAt = computed(() => stamp(this.note().createdAt));
  /** "Made 4 times, last Oct 2", from the meal plans' ticked dinners (#129). */
  protected readonly made = computed(() =>
    madeLine(this.notes.made().get(normalizeName(this.note().title))),
  );
  protected readonly edited = computed(() => stamp(this.note().updatedAt));
  protected readonly sentAt = computed(() => stamp(this.note().sentAt));

  /** Do it now (#144 step 3): the garden's own agent, on Eric's Anthropic key. */
  private readonly keys = inject(KeysService);
  private readonly agentRuns = inject(RunsService);
  /** With an Anthropic key kept, and no run already going. */
  protected readonly canRunNow = computed(() => {
    const run = this.run();
    const going = run && (run.status === 'working' || run.status === 'requested') && !this.stale();
    return !!this.keys.keys()?.anthropic && !going;
  });
  /** Ticks while a run is watched, so a lost run reads as lost in time (review on #152). */
  private readonly tick = signal(Date.now());
  protected readonly stale = computed(() => {
    const run = this.run();
    if (!run || (run.status !== 'working' && run.status !== 'requested')) return false;
    return run.since !== undefined && this.tick() - run.since > RUN_STALE_MS;
  });
  protected readonly starting = signal(false);
  protected readonly runStatus = signal('');
  private readonly watched = signal<RunView | undefined>(undefined);
  protected readonly run = computed(() => (this.note().sendRun ? this.watched() : undefined));

  protected async doItNow(): Promise<void> {
    this.starting.set(true);
    this.runStatus.set('');
    try {
      await this.agentRuns.start(this.note().id);
    } catch (err) {
      this.runStatus.set(`Could not start: ${(err as Error).message}`);
    } finally {
      this.starting.set(false);
    }
  }

  /** Sends the note to Eric's assistant with what he asked (#143). */
  protected send(event: Event, ask: HTMLInputElement): void {
    event.preventDefault();
    this.notes.sendToAssistant(this.note().id, ask.value);
    ask.value = '';
  }
  /** Who wrote last: an assistant, this device, or another of Eric's. */
  protected readonly by = computed(() => {
    const note = this.note();
    if (note.updatedBy === 'claude') return `by ${note.agent ?? 'Claude'}`;
    if (!note.deviceId) return '';
    return note.deviceId.startsWith(this.notes.deviceId()) ? 'on this device' : 'on another device';
  });
  /** The field, or the section a template from before #111 still holds. */
  protected readonly instructionsText = computed(
    () => templateParts(this.note().body, this.note().instructions).instructions,
  );
  private readonly instructionsBox = viewChild<ElementRef<HTMLTextAreaElement>>('instructions');
  /** Instructions typed and kept on the device, waiting for the pause to write. */
  private typed?: { id: string; text: string; timer: ReturnType<typeof setTimeout> };
  /** Which template's instructions the field shows. */
  private shown?: string;

  constructor() {
    // Watch the note's run while it has one (#144 step 3).
    effect((onCleanup) => {
      const runId = this.note().sendRun;
      untracked(() => this.watched.set(undefined));
      if (!runId) return;
      onCleanup(this.agentRuns.watch(runId, (run) => this.watched.set(run)));
      this.tick.set(Date.now());
      const timer = setInterval(() => this.tick.set(Date.now()), 30_000);
      onCleanup(() => clearInterval(timer));
    });
    let stop: (() => void) | undefined;
    effect(() => {
      const uid = this.auth.user()?.uid;
      stop?.();
      stop = undefined;
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
    // The field shows the stored instructions, except while it has focus:
    // a snapshot of an earlier write must never land on later typing.
    const doc = inject(DOCUMENT);
    effect(() => {
      const box = this.instructionsBox()?.nativeElement;
      const text = this.instructionsText();
      const id = this.note().id;
      if (!box || (box === doc.activeElement && this.shown === id)) return;
      box.value = text;
      this.shown = id;
    });
    // A page closed with the field focused never fires change (#200).
    const onPageHide = () => this.writeInstructions();
    doc.defaultView?.addEventListener('pagehide', onPageHide);
    inject(DestroyRef).onDestroy(() => {
      stop?.();
      doc.defaultView?.removeEventListener('pagehide', onPageHide);
      this.writeInstructions();
    });
  }

  /**
   * Every keystroke in Instructions for Claude: kept on the device at
   * once, so a page closed now keeps it, and written after a pause.
   */
  protected typeInstructions(value: string): void {
    const id = this.note().id;
    const text = value.trim();
    // Typed into another template's field: that one is written first.
    if (this.typed && this.typed.id !== id) this.writeInstructions();
    clearTimeout(this.typed?.timer);
    this.notes.holdInstructions(id, text);
    this.typed = { id, text, timer: setTimeout(() => this.writeInstructions(), SAVE_DELAY_MS) };
  }

  /** Writes the instructions waiting for a pause, now. */
  protected writeInstructions(): void {
    const typed = this.typed;
    if (!typed) return;
    clearTimeout(typed.timer);
    this.typed = undefined;
    this.notes.setInstructions(typed.id, typed.text);
  }

  /**
   * Leaving the field (change): what waits is written now. With nothing
   * waiting, the words are written only if the note does not hold them,
   * as when a change comes without input events.
   */
  protected leaveInstructions(value: string): void {
    if (!this.typed && value.trim() === (this.note().instructions ?? '')) return;
    this.typeInstructions(value);
    this.writeInstructions();
  }

  protected setServings(value: string): void {
    const n = Number(value);
    this.notes.updateRecipe(this.note().id, {
      servings: value.trim() && Number.isFinite(n) && n > 0 ? Math.round(n) : null,
    });
  }

  protected setMode(mode: string): void {
    this.notes.setTemplateMode(this.note().id, mode === 'living' ? 'living' : 'entry');
  }

  protected when(run: RunRecord): string {
    return stamp(run.at);
  }
}
