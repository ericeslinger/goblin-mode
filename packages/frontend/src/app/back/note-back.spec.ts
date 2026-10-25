import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ModulesService } from '../modules/modules.service';
import { provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { ACTIVITY_API, type ActivityApi } from '../claude/activity';
import { LinksService } from '../links/links.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import {
  FakeAuthService,
  FakeModules,
  FakeNotes,
  noteRecord,
  remindersTestProviders,
  FakeRemindersApi,
} from '../testing/fakes';
import { RunsService, type RunView } from '../agent/runs.service';
import { KeysService } from '../keys/keys.service';
import { NoteBack } from './note-back';

/** Do it now (#144 step 3): a key kept or not, and one run to watch. */
const keys = { keys: signal<Record<string, unknown> | undefined>({}) };
const agentRuns = {
  start: vi.fn(async () => ({ runId: 'r1' })),
  next: undefined as ((run: RunView | undefined) => void) | undefined,
  watch: vi.fn((_id: string, next: (run: RunView | undefined) => void) => {
    agentRuns.next = next;
    return () => undefined;
  }),
};

async function render(note: NoteRecord, runs: { id: string; data: Record<string, unknown> }[]) {
  const notes = new FakeNotes();
  notes.signIn([note]);
  const auth = new FakeAuthService();
  auth.user.set({ uid: 'u1' } as User);
  const activity: ActivityApi = {
    listen: (_db, path, next) => {
      expect(path).toBe('users/u1/activity');
      next(runs);
      return () => undefined;
    },
  };
  TestBed.configureTestingModule({
    imports: [NoteBack],
    providers: [
      provideRouter([]),
      ...remindersTestProviders(new FakeRemindersApi(), () => Date.now()),
      { provide: NotesService, useValue: notes },
      { provide: AuthService, useValue: auth },
      { provide: ACTIVITY_API, useValue: activity },
      { provide: KeysService, useValue: keys },
      { provide: RunsService, useValue: agentRuns },
      {
        provide: LinksService,
        useValue: {
          backlinksTo: () => [{ id: 'n2', title: 'Glaze shelf', sentence: 'See [[pots]]' }],
          togetherWith: () => [],
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(NoteBack);
  fixture.componentRef.setInput('note', note);
  await fixture.whenStable();
  return { el: fixture.nativeElement as HTMLElement, notes, fixture };
}

const run = (id: string, summary: string, noteIds: string[]) => ({
  id,
  data: {
    at: { toMillis: () => Date.parse('2026-10-17T12:00:00Z') },
    summary,
    notes: noteIds.map((n) => ({ id: n, title: n })),
    reminders: [],
  },
});

describe('NoteBack (#112)', () => {
  it('says when the note was made and edited, by whom, and what Claude changed on it', async () => {
    const note: NoteRecord = {
      ...noteRecord('pots', 'Pots'),
      createdAt: Date.parse('2026-10-11T21:00:00Z'),
      updatedAt: Date.parse('2026-10-17T12:00:00Z'),
      updatedBy: 'claude',
      tags: ['studio'],
    };
    const { el } = await render(note, [
      run('r1', 'Filed Lovers vase here', ['pots']),
      run('r2', 'Changed another note', ['other']),
    ]);
    expect(el.querySelector('.times')!.textContent).toContain('Made');
    expect(el.querySelector('.times')!.textContent).toContain('by Claude');
    const changes = el.querySelector('[aria-labelledby="claude-changes"]')!;
    expect(changes.textContent).toContain('Filed Lovers vase here');
    expect(changes.textContent).not.toContain('Changed another note');
    expect(el.textContent).toContain('Glaze shelf');
    expect(el.textContent).toContain('studio');
    expect(el.querySelector('a[href="/history?note=pots"]')).not.toBeNull();
  });

  it('says who edited last from this device or another', async () => {
    const { el } = await render(
      { ...noteRecord('n1', 'x'), updatedAt: 1, updatedBy: 'user', deviceId: 'elsewhere' },
      [],
    );
    expect(el.querySelector('.times')!.textContent).toContain('on another device');
    expect(el.textContent).toContain('No assistant changed this note lately.');
  });

  it('sets a recipe’s servings and source link, and shows its original text (#127)', async () => {
    const recipe: NoteRecord = {
      ...noteRecord('r1', '## Ingredients'),
      title: 'Shakshuka',
      kind: 'recipe',
      servings: 2,
      source: { url: 'https://x.test/shakshuka', text: 'Eggs in a spiced tomato sauce.' },
    };
    const { el, notes } = await render(recipe, []);
    expect(el.querySelector('input[type="number"]')).toBeNull();
    (TestBed.inject(ModulesService) as unknown as FakeModules).set('kitchen', true);
    await TestBed.inject(ApplicationRef).whenStable();
    const serves = el.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(serves.value).toBe('2');
    serves.value = '4';
    serves.dispatchEvent(new Event('change'));
    expect(notes.updateRecipe).toHaveBeenLastCalledWith('r1', { servings: 4 });
    serves.value = '';
    serves.dispatchEvent(new Event('change'));
    expect(notes.updateRecipe).toHaveBeenLastCalledWith('r1', { servings: null });
    const url = el.querySelector<HTMLInputElement>('input[type="url"]')!;
    url.value = 'https://y.test';
    url.dispatchEvent(new Event('change'));
    expect(notes.updateRecipe).toHaveBeenLastCalledWith('r1', { url: 'https://y.test' });
    expect(el.querySelector('a[href="https://x.test/shakshuka"]')).not.toBeNull();
    expect(el.querySelector('details')!.textContent).toContain('Eggs in a spiced tomato sauce.');
  });

  it('edits a template’s mode and Instructions for Claude, showing an old section (#111)', async () => {
    const template: NoteRecord = {
      ...noteRecord('t1', 'Packing\n\n## Instructions for Claude\nAsk first.'),
      kind: 'template',
    };
    const { el, notes } = await render(template, []);
    const box = el.querySelector('textarea')!;
    expect(box.value).toBe('Ask first.');
    box.value = 'Ask where to.';
    box.dispatchEvent(new Event('change'));
    expect(notes.setInstructions).toHaveBeenCalledWith('t1', 'Ask where to.');
  });

  it('sends the note to an assistant, says it waits, and shows what was done (#143)', async () => {
    const { el, notes } = await render(noteRecord('n1', 'Glaze notes'), []);
    const box = el.querySelector<HTMLInputElement>('.send input')!;
    box.value = 'File this under pottery';
    el.querySelector<HTMLFormElement>('.send')!.dispatchEvent(new Event('submit'));
    expect(notes.sendToAssistant).toHaveBeenCalledWith('n1', 'File this under pottery');
    expect(box.value).toBe('');
    TestBed.resetTestingModule();

    const waiting = await render(
      { ...noteRecord('n2', 'Seeds'), sendState: 'queued', sendAsk: 'Plant them', sentAt: 1 },
      [],
    );
    expect(waiting.el.textContent).toContain('Waiting for your assistant');
    expect(waiting.el.textContent).toContain('“Plant them”');
    expect(waiting.el.querySelector('.send')).toBeNull();
    TestBed.resetTestingModule();

    const done = await render(
      { ...noteRecord('n3', 'Moss'), sendState: 'done', sendOutcome: 'Linked it to pottery.' },
      [],
    );
    expect(done.el.textContent).toContain('Done: Linked it to pottery.');
  });

  const button = (el: HTMLElement, text: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

  it('does a sent note now with an Anthropic key, and follows the run (#144)', async () => {
    const queued = { ...noteRecord('n4', 'Seeds'), sendState: 'queued' as const, sentAt: 1 };
    keys.keys.set({});
    const without = await render(queued, []);
    expect(button(without.el, 'Do it now')).toBeUndefined();
    TestBed.resetTestingModule();

    keys.keys.set({ anthropic: { masked: 'sk-ant-…0123', broken: false } });
    const { el, fixture } = await render(queued, []);
    button(el, 'Do it now')!.click();
    await vi.waitFor(() => expect(agentRuns.start).toHaveBeenCalledWith('n4'));
    fixture.componentRef.setInput('note', { ...queued, sendRun: 'r1' });
    await fixture.whenStable();
    expect(agentRuns.watch).toHaveBeenCalledWith('r1', expect.any(Function));
    agentRuns.next!({ status: 'working', steps: 2, stale: false });
    TestBed.tick();
    expect(el.textContent).toContain('Doing it now: 2 steps so far.');
    expect(button(el, 'Do it now')).toBeUndefined();
    // A run lost with its function can be tried again (review on #152).
    agentRuns.next!({ status: 'working', steps: 2, stale: true });
    TestBed.tick();
    expect(el.textContent).toContain('The run seems lost after 2 steps; try again.');
    expect(button(el, 'Do it now')).toBeTruthy();
    agentRuns.next!({ status: 'failed', steps: 2, error: 'the note was taken back', stale: false });
    TestBed.tick();
    expect(el.textContent).toContain('Could not do it now: the note was taken back');
    expect(button(el, 'Do it now')).toBeTruthy();
  });
});
