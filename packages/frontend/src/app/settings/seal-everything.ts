import { Component, InjectionToken, Injector, computed, inject, signal } from '@angular/core';
import {
  SEAL_COUNTED,
  type SealCounted,
  type SealLeftReason,
  type SealCursor,
  type SealPass,
  type SealReport,
  type SealRequest,
  addSealReports,
  sealLeftTotal,
} from '@mossgoblin/schema';
import { httpsCallable } from 'firebase/functions';
import { FIREBASE } from '../firebase';

/**
 * How long the app waits for one call: a little over the callable's own
 * limit (an hour, packages/functions/src/notes/seal-everything.ts).
 */
export const SEAL_CALL_TIMEOUT_MS = 61 * 60 * 1000;

/** The `sealEverything` callable, as a seam for unit specs. */
export interface SealAllApi {
  pass(request: SealRequest): Promise<SealPass>;
}

export const SEAL_ALL_API = new InjectionToken<SealAllApi>('seal-all-api', {
  providedIn: 'root',
  factory: () => {
    // Firebase is reached only when a pass is asked for.
    const injector = inject(Injector);
    return {
      pass: async (request) =>
        (
          await httpsCallable<SealRequest, SealPass>(
            injector.get(FIREBASE).functions,
            'sealEverything',
            { timeout: SEAL_CALL_TIMEOUT_MS },
          )(request)
        ).data,
    };
  },
});

type Phase =
  'idle' | 'counting' | 'counted' | 'sealing' | 'checking' | 'done' | 'stopped' | 'paused';

/** Where a pass the server stopped can go on from (review on #277). */
interface Paused {
  during: 'count' | 'seal' | 'check';
  cursor?: SealCursor;
  /** What was done before it stopped, to add the rest to. */
  report: SealReport;
  /** The pass's report, for a check that stopped. */
  done?: SealReport;
}

/** The server stopped a pass for a reason of the whole pass, not of one note. */
class ServerStopped extends Error {
  constructor(
    readonly stopped: NonNullable<SealPass['stopped']>,
    readonly cursor: SealCursor | undefined,
    readonly report: SealReport,
  ) {
    super(stopped.reason);
  }
}

/** What the page says when the server stopped a pass, in plain words. */
export function stoppedLine(stopped: NonNullable<SealPass['stopped']>): string {
  const rest =
    'Nothing was harmed. Try again in a few minutes: Carry on picks up where it stopped.';
  return stopped.reason === 'no-key'
    ? `The note key could not be fetched, so the pass stopped. ${rest}`
    : `The server failed the same way again and again${stopped.error ? ` (${stopped.error})` : ''}, so the pass stopped rather than go through every note. ${rest}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What each kind is called on the page. */
const WHAT: Record<SealCounted, (n: number) => string> = {
  notes: (n) => plural(n, 'note'),
  versions: (n) => plural(n, 'older version in History', 'older versions in History'),
  suggestions: (n) => plural(n, 'suggestion'),
  runs: (n) => plural(n, 'assistant run'),
  activity: (n) =>
    plural(n, 'entry in What assistants changed', 'entries in What assistants changed'),
};

/** The day a date falls on, in words. */
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

/** What a dry run found, line by line. */
export function dryRunLines(r: SealReport): string[] {
  const found = SEAL_COUNTED.filter((k) => r.sealed[k] > 0);
  const lines = found.length
    ? [
        `Not sealed yet: ${found
          .map((k) =>
            k === 'activity' ? `${WHAT[k](r.sealed[k])} to relabel` : WHAT[k](r.sealed[k]),
          )
          .join(', ')}.`,
      ]
    : ['Everything is sealed already.'];
  return [...lines, ...leftLines(r), ...replacedLines(r)];
}

/** What a pass did, line by line, with what the check after it found. */
export function summaryLines(done: SealReport, check: SealReport): string[] {
  const sealed = SEAL_COUNTED.filter((k) => k !== 'activity' && done.sealed[k] > 0);
  const lines: string[] = [];
  lines.push(
    sealed.length
      ? `Sealed ${sealed.map((k) => WHAT[k](done.sealed[k])).join(', ')}.`
      : 'Nothing needed sealing.',
  );
  if (done.sealed.activity) lines.push(`Relabelled ${WHAT.activity(done.sealed.activity)}.`);
  const plainLeft = SEAL_COUNTED.reduce((n, k) => n + check.sealed[k], 0);
  if (!plainLeft && !sealLeftTotal(check))
    lines.push('The check after found nothing left in the clear.');
  else {
    if (plainLeft) {
      lines.push(
        `The check after found ${plainLeft === 1 ? 'one thing' : `${plainLeft} things`} written plain since, by a device that had not heard sealing is on. Run it again to seal ${plainLeft === 1 ? 'it' : 'them'}.`,
      );
    }
    lines.push(...leftLines(check));
  }
  return [...lines, ...replacedLines(check)];
}

/** What is left as it is, and why, in plain words. */
function leftLines(r: SealReport): string[] {
  const out: string[] = [];
  const by = (reason: SealLeftReason) =>
    SEAL_COUNTED.filter((k) => (r.left[k][reason] ?? 0) > 0).map((k) =>
      WHAT[k](r.left[k][reason] ?? 0),
    );
  const unopened = by('cannot-open');
  if (unopened.length) {
    out.push(
      `Left as they are: ${unopened.join(', ')} that could not be opened with your key. Nothing in them is changed.`,
    );
  }
  const busy = by('busy');
  if (busy.length) {
    out.push(
      `Left for next time: ${busy.join(', ')} whose import was asked for a few minutes ago and is being read now. Run this again in a quarter of an hour.`,
    );
  }
  const large = by('too-large');
  if (large.length) {
    out.push(
      `Left as they are: ${large.join(', ')} too large to seal (sealed text is about a third longer, and one note can hold only so much). Split a very long note into two, then run this again.`,
    );
  }
  const changing = by('contended');
  if (changing.length) {
    out.push(
      `Left as they are: ${changing.join(', ')} that kept being changed while this ran. Run it again when nothing else is editing them.`,
    );
  }
  const failed = by('failed');
  if (failed.length) {
    const names = Object.keys(r.failures ?? {});
    out.push(
      `Left as they are: ${failed.join(', ')} the server could not seal${names.length ? ` (${names.join(', ')})` : ''}. Nothing in them is changed. Run it again; if they are still left, please report it.`,
    );
  }
  const unchecked = by('not-verified');
  if (unchecked.length) {
    out.push(
      `Left as they are: ${unchecked.join(', ')} whose sealed text did not open back to the same words, so nothing was written. Please report this.`,
    );
  }
  const kept = r.left.runs['id-kept'] ?? 0;
  if (kept) {
    out.push(
      `${plural(kept, 'older assistant run is', 'older assistant runs are')} sealed but keep${kept === 1 ? 's' : ''} ${kept === 1 ? 'its' : 'their'} old name, because a newer run for the same item has the new one, or ${kept === 1 ? 'it has' : 'they have'} not finished. Run this again once ${kept === 1 ? 'it has' : 'they have'}.`,
    );
  }
  return out;
}

/** The replaced texts, left to expire (Eric, 2026-11-15). */
function replacedLines(r: SealReport): string[] {
  if (!r.replaced.plain) return [];
  const when = r.replaced.lastExpiresAt
    ? ` by ${day(r.replaced.lastExpiresAt)}`
    : ' within two days';
  return [
    `${plural(r.replaced.plain, 'copy', 'copies')} of text an edit replaced, kept for two days to merge edits from two devices, ${r.replaced.plain === 1 ? 'is' : 'are'} not sealed and will be gone${when}.`,
  ];
}

/**
 * Seal everything now (note encryption, the migration, Eric,
 * 2026-11-15): a dry run that says what would be sealed, then, on a
 * second tap, the pass itself, which runs on the server. One call
 * normally does it all; the page calls again only when the server ran
 * out of time, and then once more as a dry run to check what is left.
 * If it is interrupted (the page closed, the connection lost), each
 * document is sealed or as it was, and running it again carries on; it
 * harmless and shows what is left.
 */
@Component({
  selector: 'app-seal-everything',
  template: `
    <h3 id="seal-everything">Seal everything now</h3>
    <p>
      Notes written before sealing was on, and their older versions, are still stored as they were.
      This seals them, and takes your notes' names out of the list of what assistants changed. It
      first counts what it would do, and changes nothing until you say so.
    </p>
    @switch (phase()) {
      @case ('counted') {
        <ul aria-label="What sealing everything would do">
          @for (line of found(); track line) {
            <li>{{ line }}</li>
          }
        </ul>
        @if (toDo()) {
          <p>
            Before you go on, open Mossgoblin on your other devices and let them sync, then close
            them. A device that stays offline through this and saves later loses nothing: its words
            are kept, and running this again seals them.
          </p>
          <div class="actions">
            <button type="button" (click)="seal()">Seal them now</button>
            <button type="button" (click)="reset()">Not now</button>
          </div>
        } @else {
          <button type="button" (click)="reset()">Done</button>
        }
      }
      @case ('done') {
        <ul aria-label="What sealing everything did">
          @for (line of found(); track line) {
            <li>{{ line }}</li>
          }
        </ul>
        <button type="button" (click)="count()">Check again</button>
      }
      @case ('paused') {
        <div class="actions">
          <button type="button" (click)="carryOn()">Carry on</button>
          <button type="button" (click)="reset()">Not now</button>
        </div>
      }
      @default {
        <button
          type="button"
          [disabled]="phase() === 'counting' || phase() === 'sealing' || phase() === 'checking'"
          (click)="count()"
        >
          Seal everything now
        </button>
      }
    }
    <p id="seal-everything-progress" class="muted" aria-live="polite">{{ progress() }}</p>
  `,
  styles: `
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .muted {
      color: var(--quiet);
      font-size: 14px;
    }
  `,
})
export class SealEverything {
  private readonly api = inject(SEAL_ALL_API);
  protected readonly phase = signal<Phase>('idle');
  protected readonly found = signal<string[]>([]);
  protected readonly progress = signal('');
  private readonly counted = signal<SealReport | undefined>(undefined);
  /** Whether the dry run found anything to seal. */
  protected readonly toDo = computed(() => {
    const r = this.counted();
    return !!r && Object.values(r.sealed).some((n) => n > 0);
  });

  private paused?: Paused;

  /**
   * Every pass a request needs, cursor to cursor, as one report, from
   * `from` when going on after a stop. A pass the server stopped throws
   * ServerStopped with where to go on from.
   */
  private async whole(
    dryRun: boolean,
    said: (report: SealReport) => string,
    from?: Paused,
  ): Promise<SealReport> {
    let pass = await this.api.pass(from?.cursor ? { dryRun, cursor: from.cursor } : { dryRun });
    let report = from ? addSealReports(from.report, pass.report) : pass.report;
    while (!pass.done) {
      if (pass.stopped) throw new ServerStopped(pass.stopped, pass.cursor, report);
      this.progress.set(said(report));
      pass = await this.api.pass({ dryRun, cursor: pass.cursor });
      report = addSealReports(report, pass.report);
    }
    return report;
  }

  /** Goes on from where the server stopped. */
  protected carryOn(): void {
    const p = this.paused;
    this.paused = undefined;
    if (!p) return;
    if (p.during === 'count') void this.count(p);
    else if (p.during === 'seal') void this.seal(p);
    else void this.check(p.done!, p);
  }

  /** The dry run: counts, writes nothing. */
  protected async count(from?: Paused): Promise<void> {
    this.phase.set('counting');
    this.found.set([]);
    this.progress.set('Counting what is not sealed yet…');
    try {
      const report = await this.whole(true, () => 'Still counting…', from);
      this.counted.set(report);
      this.found.set(dryRunLines(report));
      this.phase.set('counted');
      this.progress.set('Counted. Nothing has been changed.');
    } catch (err) {
      this.stopped(err, 'count');
    }
  }

  /** The pass itself, then a dry run to check what is left. */
  protected async seal(from?: Paused): Promise<void> {
    this.phase.set('sealing');
    this.found.set([]);
    this.progress.set(
      'Sealing on the server. This can take several minutes: keep this page open until it says it has finished. If it is interrupted, nothing is harmed, and tapping Seal everything now again carries on.',
    );
    let done: SealReport;
    try {
      done = await this.whole(
        false,
        (r) =>
          `Still sealing. So far: ${
            SEAL_COUNTED.filter((k) => r.sealed[k])
              .map((k) => WHAT[k](r.sealed[k]))
              .join(', ') || 'nothing yet'
          }.`,
        from,
      );
    } catch (err) {
      this.stopped(err, 'seal');
      return;
    }
    await this.check(done);
  }

  /** The dry run after a pass, to say what is left. */
  private async check(done: SealReport, from?: Paused): Promise<void> {
    this.phase.set('checking');
    this.progress.set('Sealed. Checking what is left…');
    try {
      const check = await this.whole(true, () => 'Still checking…', from);
      this.found.set(summaryLines(done, check));
      this.phase.set('done');
      this.progress.set('Finished.');
    } catch (err) {
      this.stopped(err, 'check', done);
    }
  }

  protected reset(): void {
    this.paused = undefined;
    this.phase.set('idle');
    this.found.set([]);
    this.counted.set(undefined);
    this.progress.set('');
  }

  private stopped(err: unknown, during: Paused['during'], done?: SealReport): void {
    if (err instanceof ServerStopped) {
      // The whole pass's trouble (the key, the same error again and
      // again): said plainly, with Carry on from where it stopped.
      this.paused = { during, cursor: err.cursor, report: err.report, done };
      this.phase.set('paused');
      this.progress.set(stoppedLine(err.stopped));
      return;
    }
    this.phase.set('stopped');
    const code = (err as { code?: unknown } | null)?.code;
    const said = err instanceof Error ? err.message : '';
    // The server's own words when it refused (sealing off, no key).
    if (code === 'functions/failed-precondition' || code === 'functions/unavailable') {
      this.progress.set(said);
      return;
    }
    this.progress.set(
      during === 'count'
        ? 'Could not reach the server to count. Nothing was changed. Try again once online.'
        : 'This was interrupted before it finished. Nothing is harmed: what was sealed stays sealed, and the rest is as it was. Tap Seal everything now again to carry on.',
    );
  }
}
