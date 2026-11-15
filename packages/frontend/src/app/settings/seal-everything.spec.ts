import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type SealPass,
  type SealReport,
  type SealRequest,
  emptySealReport,
} from '@mossgoblin/schema';
import { SEAL_ALL_API, SealEverything, dryRunLines, summaryLines } from './seal-everything';

// Seal everything now (the migration, 2026-11-15): a dry run first,
// then the pass on a second, explicit tap, with progress said politely,
// then a summary and the check of what is left.

function report(dryRun: boolean, over: Partial<SealReport> = {}): SealReport {
  return { ...emptySealReport(dryRun), ...over };
}

const counts = (notes = 0, versions = 0, suggestions = 0, runs = 0, activity = 0) => ({
  notes,
  versions,
  suggestions,
  runs,
  activity,
});

let answers: ((req: SealRequest) => Promise<SealPass>)[];
let asked: SealRequest[];

async function render() {
  asked = [];
  await TestBed.configureTestingModule({
    imports: [SealEverything],
    providers: [
      {
        provide: SEAL_ALL_API,
        useValue: {
          pass: (req: SealRequest) => {
            asked.push(req);
            const next = answers.shift();
            if (!next) throw new Error('no answer');
            return next(req);
          },
        },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(SealEverything);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const settle = () => TestBed.inject(ApplicationRef).whenStable();
  const button = (text: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  const progress = () => el.querySelector('#seal-everything-progress')!;
  return { el, settle, button, progress };
}

const ok = (r: SealReport, cursor?: SealPass['cursor']) => async (): Promise<SealPass> =>
  cursor ? { done: false, cursor, report: r } : { done: true, report: r };

describe('Seal everything now', () => {
  it('counts first, changing nothing, and seals only on the second tap', async () => {
    answers = [
      ok(
        report(true, {
          sealed: counts(12, 40, 2, 1, 30),
          replaced: { plain: 3, lastExpiresAt: '2026-11-17T10:00:00.000Z' },
        }),
      ),
    ];
    const { el, settle, button, progress } = await render();
    expect(progress().getAttribute('aria-live')).toBe('polite');
    expect(el.querySelector('[role="status"]')).toBeNull();
    button('Seal everything now')!.click();
    await settle();
    expect(asked).toEqual([{ dryRun: true }]);
    const list = el.querySelector('ul[aria-label="What sealing everything would do"]')!;
    expect(list.textContent).toContain(
      'Not sealed yet: 12 notes, 40 older versions in History, 2 suggestions, 1 assistant run, 30 entries in What assistants changed to relabel.',
    );
    expect(list.textContent).toContain('3 copies of text an edit replaced');
    expect(el.textContent).toContain('open Mossgoblin on your other devices and let them sync');
    expect(progress().textContent).toContain('Nothing has been changed.');

    // The second, explicit tap: the pass, then a check.
    answers = [
      ok(report(false, { sealed: counts(12, 40, 2, 1, 30), runsMoved: 1 })),
      ok(report(true)),
    ];
    button('Seal them now')!.click();
    await settle();
    expect(asked.slice(1)).toEqual([{ dryRun: false }, { dryRun: true }]);
    const done = el.querySelector('ul[aria-label="What sealing everything did"]')!;
    expect(done.textContent).toContain(
      'Sealed 12 notes, 40 older versions in History, 2 suggestions, 1 assistant run.',
    );
    expect(done.textContent).toContain('Relabelled 30 entries in What assistants changed.');
    expect(done.textContent).toContain('The check after found nothing left in the clear.');
    expect(progress().textContent).toBe('Finished.');
  });

  it('does not offer to seal when everything is sealed already', async () => {
    answers = [ok(report(true))];
    const { el, settle, button } = await render();
    button('Seal everything now')!.click();
    await settle();
    expect(el.textContent).toContain('Everything is sealed already.');
    expect(button('Seal them now')).toBeUndefined();
  });

  it('says not now and changes nothing', async () => {
    answers = [ok(report(true, { sealed: counts(1) }))];
    const { settle, button } = await render();
    button('Seal everything now')!.click();
    await settle();
    button('Not now')!.click();
    await settle();
    expect(asked).toEqual([{ dryRun: true }]);
    expect(button('Seal everything now')).toBeDefined();
  });

  it('calls again from the cursor when the server ran out of time, and says how far it is', async () => {
    answers = [ok(report(true, { sealed: counts(3) }))];
    const { el, settle, button, progress } = await render();
    button('Seal everything now')!.click();
    await settle();
    let resume!: () => void;
    const second = new Promise<void>((done) => (resume = done));
    answers = [
      ok(report(false, { sealed: counts(2) }), { kind: 'notes', after: 'n2' }),
      async () => {
        await second;
        return { done: true, report: report(false, { sealed: counts(1) }) };
      },
      ok(
        report(true, {
          left: { ...report(true).left, notes: { 'cannot-open': 1, busy: 1 } },
        }),
      ),
    ];
    button('Seal them now')!.click();
    await new Promise((r) => setTimeout(r));
    TestBed.tick();
    expect(progress().textContent).toContain('Still sealing. So far: 2 notes.');
    expect(asked.at(-1)).toEqual({ dryRun: false, cursor: { kind: 'notes', after: 'n2' } });
    resume();
    await new Promise((r) => setTimeout(r));
    await settle();
    const done = el.querySelector('ul[aria-label="What sealing everything did"]')!;
    expect(done.textContent).toContain('Sealed 3 notes.');
    expect(done.textContent).toContain('1 note that could not be opened with your key');
    expect(done.textContent).toContain('1 note whose import was asked for a few minutes ago');
  });

  it('resumes after the connection dropped: a new count shows what is left', async () => {
    answers = [ok(report(true, { sealed: counts(5) }))];
    const { el, settle, button, progress } = await render();
    button('Seal everything now')!.click();
    await settle();
    answers = [
      async () => {
        throw Object.assign(new Error('deadline-exceeded'), {
          code: 'functions/deadline-exceeded',
        });
      },
    ];
    button('Seal them now')!.click();
    await settle();
    expect(progress().textContent).toContain('This was interrupted before it finished.');
    expect(progress().textContent).toContain('Nothing is harmed');
    expect(progress().textContent).toContain('again to carry on');
    // Running it again counts afresh, from the start: harmless.
    answers = [ok(report(true, { sealed: counts(2) }))];
    button('Seal everything now')!.click();
    await settle();
    expect(asked.at(-1)).toEqual({ dryRun: true });
    expect(el.textContent).toContain('Not sealed yet: 2 notes.');
  });

  it('shows the server’s own words when it refuses', async () => {
    answers = [
      async () => {
        throw Object.assign(new Error('Sealing is off, so nothing was sealed. Turn it on first.'), {
          code: 'functions/failed-precondition',
        });
      },
    ];
    const { settle, button, progress } = await render();
    button('Seal everything now')!.click();
    await settle();
    expect(progress().textContent).toBe('Sealing is off, so nothing was sealed. Turn it on first.');
  });
});

describe('a pass the server stopped', () => {
  it('says the key could not be fetched, and carries on from where it stopped', async () => {
    answers = [ok(report(true, { sealed: counts(3) }))];
    const { el, settle, button, progress } = await render();
    button('Seal everything now')!.click();
    await settle();
    answers = [
      async () => ({
        done: false,
        cursor: { kind: 'notes', after: 'n2' },
        stopped: { reason: 'no-key' },
        report: report(false, { sealed: counts(2) }),
      }),
    ];
    button('Seal them now')!.click();
    await settle();
    expect(progress().textContent).toContain(
      'The note key could not be fetched, so the pass stopped. Nothing was harmed. Try again in a few minutes',
    );
    expect(el.textContent).not.toContain('could not be opened with your key');
    answers = [ok(report(false, { sealed: counts(1) })), ok(report(true))];
    button('Carry on')!.click();
    await new Promise((r) => setTimeout(r));
    await settle();
    expect(asked.at(-2)).toEqual({ dryRun: false, cursor: { kind: 'notes', after: 'n2' } });
    const done = el.querySelector('ul[aria-label="What sealing everything did"]')!;
    expect(done.textContent).toContain('Sealed 3 notes.');
  });

  it('names an error that came again and again', async () => {
    answers = [
      async () => ({
        done: false,
        cursor: { kind: 'notes' },
        stopped: { reason: 'repeated-failure', error: 'Error (7)' },
        report: report(true),
      }),
    ];
    const { settle, button, progress } = await render();
    button('Seal everything now')!.click();
    await settle();
    expect(progress().textContent).toContain('failed the same way again and again (Error (7))');
    expect(button('Carry on')).toBeDefined();
  });
});

describe('the words', () => {
  it('ask to keep the page open, and never say the server carries on alone', async () => {
    answers = [ok(report(true, { sealed: counts(1) }))];
    const { settle, button, progress } = await render();
    button('Seal everything now')!.click();
    await settle();
    answers = [() => new Promise<SealPass>(() => undefined)];
    button('Seal them now')!.click();
    await settle();
    expect(progress().textContent).toContain('keep this page open until it says it has finished');
    expect(progress().textContent).not.toMatch(/leave this page|carries on on the server/);
  });

  it('say what Eric can do about each thing left', () => {
    const left = report(true, {
      left: {
        ...report(true).left,
        notes: { 'too-large': 1, contended: 2, failed: 1 },
        runs: { 'id-kept': 1 },
      },
      failures: { 'BoomError (13)': 1 },
    });
    const text = dryRunLines(left).join(' ');
    expect(text).toContain('1 note too large to seal');
    expect(text).toContain('Split a very long note into two');
    expect(text).toContain('2 notes that kept being changed');
    expect(text).toContain('the server could not seal (BoomError (13))');
    expect(text).toContain('1 older assistant run is sealed but keeps its old name');
  });

  it('say what is left to expire, and by when', () => {
    const lines = dryRunLines(
      report(true, { replaced: { plain: 1, lastExpiresAt: '2026-11-17T10:00:00.000Z' } }),
    );
    expect(lines.join(' ')).toMatch(
      /1 copy of text an edit replaced.* is not sealed and will be gone by /,
    );
  });

  it('say when a device wrote plain since', () => {
    const lines = summaryLines(
      report(false, { sealed: counts(1) }),
      report(true, { sealed: counts(1) }),
    );
    expect(lines.join(' ')).toContain('written plain since, by a device that had not heard');
  });
});
