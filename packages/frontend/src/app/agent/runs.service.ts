import {
  Injectable,
  InjectionToken,
  Injector,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { type DataKey, type RunStatus, isSealed, paths } from '@mossgoblin/schema';
import { httpsCallable } from 'firebase/functions';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NoteKeyService } from '../notes/note-key.service';
import { openRecordField } from '../notes/notes.service';
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
  /** When it started (or was asked for), in milliseconds, to tell a lost run. */
  since?: number;
  /** Its outcome is sealed and did not open on this device (step 3e); `outcome` is then absent. */
  sealed?: true;
}

/** What the note's back says for a run outcome that is sealed and did not open here. */
export const SEALED_OUTCOME =
  'sealed, and its key is not on this device yet; it shows once this device is back online and signed in.';

const millis = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.();

/**
 * A stored run as the note's back shows it. A sealed outcome (step 3e,
 * 2026-11-13) opens with `open`; one that does not open is left out and
 * the view says `sealed`, never the sealed text.
 */
export function toRunView(
  data: Record<string, unknown>,
  open: (value: string) => string | undefined = () => undefined,
): RunView {
  const raw = data['status'];
  const status: RunStatus =
    raw === 'working' || raw === 'done' || raw === 'failed' ? raw : 'requested';
  const since = millis(data['startedAt']) ?? millis(data['createdAt']);
  return {
    status,
    steps: Array.isArray(data['steps']) ? data['steps'].length : 0,
    ...(since === undefined ? {} : { since }),
    ...outcomeOf(data['outcome'], open),
    ...(typeof data['error'] === 'string' ? { error: data['error'] } : {}),
  };
}

function outcomeOf(
  value: unknown,
  open: (value: string) => string | undefined,
): Pick<RunView, 'outcome' | 'sealed'> {
  if (typeof value !== 'string') return {};
  if (!isSealed(value)) return { outcome: value };
  const opened = open(value);
  return opened === undefined ? { sealed: true } : { outcome: opened };
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
  private readonly injector = inject(Injector);

  start(noteId: string): Promise<{ runId: string }> {
    return this.api.start(noteId);
  }

  /**
   * One run, live, to `next` until the returned stop is called. Derived
   * from the stored run and the key (step 3e), so a key that arrives
   * later opens a sealed outcome then; the key is read only for one.
   */
  watch(runId: string, next: (run: RunView | undefined) => void): () => void {
    const uid = this.auth.user()?.uid;
    if (!uid) return () => undefined;
    /** Nothing heard yet, the run gone, or the run as stored. */
    const stored = signal<{ data: Record<string, unknown> | undefined } | undefined>(undefined);
    // Its own effect, made outside any caller's reactive context.
    const shown = untracked(() =>
      effect(
        () => {
          const got = stored();
          if (!got) return;
          let key: DataKey | undefined;
          let read = false;
          const open = (value: string) => {
            if (!read) [key, read] = [this.injector.get(NoteKeyService).key(), true];
            return openRecordField(key, uid, 'runs', runId, 'outcome', value);
          };
          const view = got.data ? toRunView(got.data, open) : undefined;
          untracked(() => next(view));
        },
        { injector: this.injector },
      ),
    );
    const stop = this.settings.listen(
      this.fb.db,
      paths.run(uid, runId),
      (data) => stored.set({ data: data ?? undefined }),
      (err) => console.error('run listener', err),
    );
    return () => {
      stop();
      shown.destroy();
    };
  }
}
