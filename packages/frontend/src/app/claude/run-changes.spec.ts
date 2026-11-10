import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { textHash } from '@mossgoblin/schema';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { HISTORY_API, type VersionRecord } from '../history/history';
import { type NoteRecord, NotesService } from '../notes/notes.service';
import {
  FakeAuthService,
  FakeHistoryApi,
  FakeNotes,
  fakeFirebase,
  noteRecord,
} from '../testing/fakes';
import type { RunRecord } from './activity';
import { RUN_SLACK_MS, RunChanges, changesText, runSides } from './run-changes';

const AT = Date.parse('2026-11-10T15:00:00Z');
const at = (ms: number) => ({ toMillis: () => ms });

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1',
  at: AT,
  agent: 'Claude',
  tool: 'add_lines',
  summary: 'Added 2 lines to Kiln log',
  notes: [{ id: 'k', title: 'Kiln log' }],
  reminders: [],
  ...over,
});

const version = (id: string, body: string, over: Partial<VersionRecord> = {}): VersionRecord => ({
  id,
  body,
  updatedBy: 'user',
  agent: 'Claude',
  reason: 'author',
  ...over,
});

const theRun = { updatedBy: 'claude' as const, agent: 'Claude', updatedAt: AT - 1000 };

describe('changesText', () => {
  it('offers the notes whose text a run wrote', () => {
    expect(changesText(run(), 0)).toBe(true);
    const merge = run({
      tool: 'merge_notes',
      notes: [
        { id: 'm', title: 'Merged', made: true },
        { id: 'o', title: 'Original' },
      ],
    });
    expect([changesText(merge, 0), changesText(merge, 1)]).toEqual([true, false]);
    const link = run({
      tool: 'link_notes',
      notes: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ],
    });
    expect([changesText(link, 0), changesText(link, 1)]).toEqual([true, false]);
    expect(changesText(run({ tool: 'archive_note', summary: 'Archived a note' }), 0)).toBe(false);
    expect(changesText(run({ tool: 'update_note', summary: 'Retitled a note' }), 0)).toBe(false);
    expect(
      changesText(run({ tool: 'update_note', summary: 'Changed the text of a note' }), 0),
    ).toBe(true);
    const filing = (before: Record<string, unknown>) =>
      run({ tool: 'refile', notes: [{ id: 'k', title: 'Kiln log', before }] });
    expect(changesText(filing({ tags: null }), 0)).toBe(false);
    expect(changesText(filing({ tags: null, body: '3-abc' }), 0)).toBe(true);
    expect(changesText(run(), 5)).toBe(false);
  });
});

describe('runSides', () => {
  it('finds the version before by the hash the run named, and the note now after', () => {
    const note: NoteRecord = { ...noteRecord('k', 'a\nb\nc'), ...theRun, baseHash: textHash('a') };
    const sides = runSides(
      run(),
      run().notes[0],
      [
        version('v2', 'a\nb', { updatedAt: AT - 60_000 }),
        version('v1', 'a', { updatedAt: AT - 600_000 }),
      ],
      note,
    );
    expect(sides.before).toEqual({ body: 'a', at: AT - 600_000, now: false });
    expect(sides.beforeApprox).toBeUndefined();
    expect(sides.after).toEqual({ body: 'a\nb\nc', now: true });
    expect(sides.afterLater).toBeUndefined();
  });

  it("uses the hash a filing's record kept", () => {
    const touched = { id: 'k', title: 'Kiln log', before: { body: textHash('old') } };
    const sides = runSides(
      run({ tool: 'refile' }),
      touched,
      [
        version('v1', 'old', { updatedAt: AT - 600_000 }),
        version('v2', 'newer', { updatedAt: AT - 9000 }),
      ],
      { ...noteRecord('k', 'old\n## Overview'), ...theRun },
    );
    expect(sides.before?.body).toBe('old');
  });

  it('falls back to the latest version written before the run, not its own', () => {
    const versions = [
      version('own', 'run text', { ...theRun }),
      version('eric', 'eric text', { updatedAt: AT - 120_000 }),
      version('older', 'older', { updatedAt: AT - 900_000 }),
    ];
    const sides = runSides(run(), run().notes[0], versions, {
      ...noteRecord('k', 'eric again'),
      updatedAt: AT + 60_000,
    });
    expect(sides.before?.body).toBe('eric text');
    // Found by time, not hash, so said to be approximate (review on #243).
    expect(sides.beforeApprox).toBe(true);
    expect(sides.after).toEqual({ body: 'run text', at: AT - 1000, now: false });
    expect(sides.afterLater).toBeUndefined();
  });

  it('says when the exact text before is gone and the time match stands in', () => {
    const note = { ...noteRecord('k', 'x'), ...theRun, baseHash: textHash('missing') };
    const sides = runSides(
      run(),
      run().notes[0],
      [version('v', 'close', { updatedAt: AT - 9e5 })],
      note,
    );
    expect(sides.before?.body).toBe('close');
    expect(sides.beforeApprox).toBe(true);
  });

  it('after a later edit with the run unkept, gives the next kept version, else the note now', () => {
    const later = version('later', 'later text', { updatedAt: AT + 300_000 });
    const note = { ...noteRecord('k', 'now'), updatedAt: AT + 900_000 };
    expect(runSides(run(), run().notes[0], [later], note)).toMatchObject({
      after: { body: 'later text', now: false },
      afterLater: true,
    });
    expect(runSides(run(), run().notes[0], [], note)).toMatchObject({
      noBefore: 'unkept',
      after: { body: 'now', now: true },
      afterLater: true,
    });
  });

  it('reads a note the run made as new, by its record or its creation', () => {
    const made = { id: 'k', title: 'Kiln log', made: true };
    const note = { ...noteRecord('k', 'new'), ...theRun };
    expect(runSides(run(), made, [], note)).toMatchObject({ noBefore: 'made' });
    expect(
      runSides(run(), run().notes[0], [], { ...note, createdAt: AT - RUN_SLACK_MS + 1 }),
    ).toMatchObject({ noBefore: 'made' });
  });

  it('has no after for a note that is gone with nothing kept since', () => {
    expect(runSides(run(), run().notes[0], [], undefined).after).toBeUndefined();
  });
});

@Component({
  imports: [RunChanges],
  template: `<app-run-changes [run]="run()" [note]="run().notes[0]" title="Kiln log" />`,
})
class Host {
  readonly run = signal(run());
}

async function render(
  versions: { id: string; data: Record<string, unknown> }[],
  notes: NoteRecord[],
) {
  const api = new FakeHistoryApi();
  api.versions.set('users/u1/notes/k/history', versions);
  const auth = new FakeAuthService();
  auth.user.set({ uid: 'u1' } as User);
  const fakeNotes = new FakeNotes();
  fakeNotes.signIn(notes);
  await TestBed.configureTestingModule({
    imports: [Host],
    providers: [
      { provide: HISTORY_API, useValue: api },
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: auth },
      { provide: NotesService, useValue: fakeNotes },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const toggle = el.querySelector('button')!;
  return {
    api,
    el,
    fixture,
    toggle,
    async click() {
      toggle.click();
      await fixture.whenStable();
    },
  };
}

const kept = (body: string, ms: number, by: 'user' | 'claude' = 'user') => ({
  id: `v${ms}`,
  data: { body, updatedBy: by, updatedAt: at(ms), savedAt: at(ms + 1), reason: 'author' },
});

describe('RunChanges', () => {
  it('reads nothing until opened, then marks the added lines and keeps the rest', async () => {
    const note = { ...noteRecord('k', 'Kiln log\n- bisque\n- glaze'), ...theRun };
    const { api, el, toggle, click } = await render(
      [kept('Kiln log\n- bisque', AT - 600_000)],
      [note],
    );
    expect(api.listen).not.toHaveBeenCalled();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Show changes: Kiln log');
    await click();
    expect(api.listen).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/notes/k/history',
      expect.any(Function),
      expect.any(Function),
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = el.querySelector(`#${toggle.getAttribute('aria-controls')}`)!;
    expect(panel.getAttribute('aria-label')).toBe('Changes to Kiln log');
    const added = [...panel.querySelectorAll('ins')].map((i) => i.textContent);
    expect(added).toEqual(['+Added: - glaze']);
    expect(panel.querySelectorAll('del').length).toBe(0);
    const [before, after] = [...panel.querySelectorAll('[role=group]')];
    expect(before.textContent).toContain('- bisque');
    expect(after.textContent).toContain('The note now');
    expect(after.textContent).toContain('- bisque');
  });

  it('marks a removed line on the before side', async () => {
    const note = { ...noteRecord('k', 'one\nthree'), ...theRun };
    const { el, click } = await render([kept('one\ntwo\nthree', AT - 600_000)], [note]);
    await click();
    expect([...el.querySelectorAll('del')].map((d) => d.textContent)).toEqual(['−Removed: two']);
  });

  it('closes again and stops listening', async () => {
    const { api, el, toggle, click } = await render([], [{ ...noteRecord('k', 'x'), ...theRun }]);
    await click();
    await click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('section')).toBeNull();
    expect(api.stops[0]).toHaveBeenCalled();
  });

  it('says when History has no version from before', async () => {
    const { el, click } = await render([], [{ ...noteRecord('k', 'only now'), ...theRun }]);
    await click();
    expect(el.textContent).toContain('History has no version from before this run.');
    expect(el.textContent).toContain('only now');
    expect(el.querySelectorAll('ins').length).toBe(0);
  });

  it('says when the text did not change', async () => {
    const { el, click } = await render(
      [kept('same', AT - 600_000)],
      [{ ...noteRecord('k', 'same'), ...theRun }],
    );
    await click();
    expect(el.textContent).toContain('The text did not change.');
  });

  it('says when History cannot be read', async () => {
    const { api, el, click } = await render([], []);
    api.fail = new Error('offline');
    await click();
    expect(el.textContent).toContain('Could not read History: offline');
  });
});
