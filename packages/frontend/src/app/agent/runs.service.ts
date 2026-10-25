import { Injectable, InjectionToken, inject } from '@angular/core';
import { RUN_STALE_MS, type RunStatus, paths } from '@mossgoblin/schema';
import { httpsCallable } from 'firebase/functions';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { SETTINGS_API } from '../theme/theme-sync.service';

/** The call that starts a run (onCall), as a seam for unit specs. */
export interface RunsApi {
  start(noteId: string): Promise<{ runId: string }>;
}

export const RUNS_API = new InjectionToken<RunsApi>('runs-api', {
  providedIn: 'root',
  factory: () => {
    const fb = inject(FIREBASE);
    return {
      start: async (noteId) =>
        (await httpsCallable<unknown, { runId: string }>(fb.functions, 'startRun')({ noteId }))
          .data,
    };
  },
});

/** A run as the note's back shows it. */
export interface RunView {
  status: RunStatus;
  steps: number;
  outcome?: string;
  error?: string;
  /** Still going, but for longer than a run can: its function was lost. */
  stale: boolean;
}

const millis = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.();

function read(data: Record<string, unknown>, now: number): RunView {
  const raw = data['status'];
  const status: RunStatus =
    raw === 'working' || raw === 'done' || raw === 'failed' ? raw : 'requested';
  const since = millis(data['startedAt']) ?? millis(data['createdAt']);
  return {
    status,
    steps: Array.isArray(data['steps']) ? data['steps'].length : 0,
    stale:
      (status === 'working' || status === 'requested') &&
      since !== undefined &&
      now - since > RUN_STALE_MS,
    ...(typeof data['outcome'] === 'string' ? { outcome: data['outcome'] } : {}),
    ...(typeof data['error'] === 'string' ? { error: data['error'] } : {}),
  };
}

/**
 * The garden's own agent runs (#144 step 3): Do it now starts one for
 * a sent note, through a callable, and the note's back watches it. A
 * run needs the network, unlike a note write; the back says so when
 * starting one fails.
 */
@Injectable({ providedIn: 'root' })
export class RunsService {
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(RUNS_API);
  private readonly settings = inject(SETTINGS_API);
  private readonly auth = inject(AuthService);

  start(noteId: string): Promise<{ runId: string }> {
    return this.api.start(noteId);
  }

  /** One run, live, to `next` until the returned stop is called. */
  watch(runId: string, next: (run: RunView | undefined) => void): () => void {
    const uid = this.auth.user()?.uid;
    if (!uid) return () => undefined;
    return this.settings.listen(
      this.fb.db,
      paths.run(uid, runId),
      (data) => next(data ? read(data, Date.now()) : undefined),
      (err) => console.error('run listener', err),
    );
  }
}
