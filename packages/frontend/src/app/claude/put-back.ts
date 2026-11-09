import { Component, InjectionToken, computed, inject, input, signal } from '@angular/core';
import { PUT_BACK_TOOL, canParent, rerouteNotes } from '@mossgoblin/schema';
import { httpsCallable } from 'firebase/functions';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { ONLINE } from '../platform/platform';
import type { RunRecord } from './activity';

/** What the revertRun callable answers (#154 step 1). */
export interface PutBackResult {
  status: 'done' | 'already';
  id: string;
  notes: number;
}

/** The calls that put a run back and file it again (onCall), as a seam for unit specs. */
export interface PutBackApi {
  revert(runId: string): Promise<PutBackResult>;
  /** Files what put back `runId` took out of a filing under `projectId` (#235). */
  reroute(runId: string, projectId: string): Promise<PutBackResult>;
}

export const PUT_BACK_API = new InjectionToken<PutBackApi>('put-back-api', {
  providedIn: 'root',
  factory: () => {
    const fb = inject(FIREBASE);
    return {
      revert: async (runId) =>
        (await httpsCallable<unknown, PutBackResult>(fb.functions, 'revertRun')({ runId })).data,
      reroute: async (runId, projectId) =>
        (
          await httpsCallable<unknown, PutBackResult>(
            fb.functions,
            'rerouteRun',
          )({ runId, projectId })
        ).data,
    };
  },
});

const notes = (n: number) => (n === 1 ? '1 note' : `${n} notes`);

/**
 * The projects "File it under…" offers for notes `filed` (#235): the
 * active ones (not archived, not done), by name, none of the notes
 * themselves, and none a project among them could not go under.
 */
export function rerouteChoices(
  all: readonly {
    id: string;
    title: string;
    conceptType?: string;
    parent?: string;
    projectStatus?: string;
    archived?: boolean;
  }[],
  filed: readonly string[],
): { id: string; title: string }[] {
  const projects = all.filter((n) => n.conceptType === 'project' && !n.archived);
  const moving = projects.filter((p) => filed.includes(p.id));
  return projects
    .filter(
      (p) =>
        p.projectStatus !== 'done' &&
        !filed.includes(p.id) &&
        moving.every((m) => canParent(m.id, p.id, projects)),
    )
    .map((p) => ({ id: p.id, title: p.title || 'Untitled' }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Put back (#154 step 1): one run in What assistants changed undone, on
 * the server, after a one-line confirm. A run already put back says so;
 * the put back shows as a run of its own above it. It needs the
 * network, unlike a note write, and says so offline. Once a filing or a
 * merge is put back, "File it under…" offers his active projects, so
 * the correction is one more tap (#235, step 2), online as well.
 */
@Component({
  selector: 'app-put-back',
  template: `
    @if (done()) {
      @if (!status()) {
        <span class="muted">Put back</span>
      }
    } @else if (confirming()) {
      <span class="confirm">
        <span [id]="'put-back-' + run().id">Put back {{ count() }}?</span>
        <button
          type="button"
          class="primary"
          [disabled]="busy()"
          [attr.aria-describedby]="'put-back-' + run().id"
          (click)="putBack()"
        >
          Yes
        </button>
        <button type="button" [disabled]="busy()" (click)="confirming.set(false)">No</button>
      </span>
    } @else {
      <!-- The label starts with the words shown (WCAG 2.5.3); a hidden span
        would add a space before the colon to the name. -->
      <button type="button" [attr.aria-label]="'Put back: ' + run().summary" (click)="ask()">
        Put back
      </button>
    }
    @if (offer() && choices().length) {
      <span class="confirm" role="group" [attr.aria-label]="'File it under: ' + run().summary">
        <span>File it under…</span>
        @for (p of choices(); track p.id) {
          <button type="button" [disabled]="busy()" (click)="fileUnder(p)">{{ p.title }}</button>
        }
        <button type="button" [disabled]="busy()" (click)="offer.set('')">Not now</button>
      </span>
    }
    @if (status()) {
      <span role="status" class="muted">{{ status() }}</span>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }
    .confirm {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }
    button {
      font: inherit;
      font-size: 14px;
      padding: 2px 12px;
      border-radius: var(--radius-pill);
      border: var(--border) solid var(--rule);
      color: var(--ink);
      background: var(--surface);
      cursor: pointer;
    }
    .primary {
      border-color: var(--accent);
      color: var(--on-accent);
      background: var(--accent);
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
  `,
})
export class PutBack {
  readonly run = input.required<RunRecord>();
  /** Whether What assistants changed lists this run's put back already. */
  readonly done = input(false);
  private readonly api = inject(PUT_BACK_API);
  private readonly online = inject(ONLINE);
  private readonly notesService = inject(NotesService);
  private readonly modules = inject(ModulesService);

  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  protected readonly status = signal('');
  protected readonly count = computed(() => notes(this.run().notes.length));
  /** The put back's own id while "File it under…" is offered (#235). */
  protected readonly offer = signal('');
  /** The notes the put back took out of a filing, which a reroute files. */
  private readonly filed = computed(() => {
    const run = this.run();
    if (run.tool === PUT_BACK_TOOL) return [];
    return rerouteNotes(run, (id) => this.notesService.find(id)?.conceptType === 'project');
  });
  protected readonly choices = computed(() =>
    this.modules.projects() && this.filed().length
      ? rerouteChoices(this.notesService.notes(), this.filed())
      : [],
  );

  protected ask(): void {
    this.status.set('');
    if (!this.online()) {
      this.status.set('Putting back needs the network.');
      return;
    }
    this.confirming.set(true);
  }

  protected async putBack(): Promise<void> {
    if (!this.online()) {
      this.confirming.set(false);
      this.status.set('Putting back needs the network.');
      return;
    }
    this.busy.set(true);
    this.status.set('Putting back…');
    try {
      const result = await this.api.revert(this.run().id);
      this.status.set(
        result.status === 'already' ? 'Already put back.' : `Put back ${notes(result.notes)}.`,
      );
      this.confirming.set(false);
      if (result.status === 'done' && this.filed().length) this.offer.set(result.id);
    } catch (err) {
      this.status.set(`Could not put back: ${(err as Error).message}`);
    } finally {
      this.busy.set(false);
    }
  }

  protected async fileUnder(project: { id: string; title: string }): Promise<void> {
    const putBackId = this.offer();
    if (!putBackId) return;
    if (!this.online()) {
      this.status.set('Filing needs the network.');
      return;
    }
    this.busy.set(true);
    this.status.set('Filing…');
    try {
      const result = await this.api.reroute(putBackId, project.id);
      this.status.set(
        result.status === 'already' ? 'Already filed again.' : `Filed under ${project.title}.`,
      );
      this.offer.set('');
    } catch (err) {
      this.status.set(`Could not file it: ${(err as Error).message}`);
    } finally {
      this.busy.set(false);
    }
  }
}
