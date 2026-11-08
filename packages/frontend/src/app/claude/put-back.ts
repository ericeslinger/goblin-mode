import { Component, InjectionToken, computed, inject, input, signal } from '@angular/core';
import { httpsCallable } from 'firebase/functions';
import { FIREBASE } from '../firebase';
import { ONLINE } from '../platform/platform';
import type { RunRecord } from './activity';

/** What the revertRun callable answers (#154 step 1). */
export interface PutBackResult {
  status: 'done' | 'already';
  id: string;
  notes: number;
}

/** The call that puts a run back (onCall), as a seam for unit specs. */
export interface PutBackApi {
  revert(runId: string): Promise<PutBackResult>;
}

export const PUT_BACK_API = new InjectionToken<PutBackApi>('put-back-api', {
  providedIn: 'root',
  factory: () => {
    const fb = inject(FIREBASE);
    return {
      revert: async (runId) =>
        (await httpsCallable<unknown, PutBackResult>(fb.functions, 'revertRun')({ runId })).data,
    };
  },
});

const notes = (n: number) => (n === 1 ? '1 note' : `${n} notes`);

/**
 * Put back (#154 step 1): one run in What assistants changed undone, on
 * the server, after a one-line confirm. A run already put back says so;
 * the put back shows as a run of its own above it. It needs the
 * network, unlike a note write, and says so offline.
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

  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  protected readonly status = signal('');
  protected readonly count = computed(() => notes(this.run().notes.length));

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
    } catch (err) {
      this.status.set(`Could not put back: ${(err as Error).message}`);
    } finally {
      this.busy.set(false);
    }
  }
}
