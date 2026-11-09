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
import { SAVE_DELAY_MS } from '../capture/capture.service';
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

async function render(
  note: NoteRecord,
  runs: { id: string; data: Record<string, unknown> }[],
  others: NoteRecord[] = [],
) {
  const notes = new FakeNotes();
  notes.signIn([note, ...others]);
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

  it('offers Put back on the runs that changed it (#154)', async () => {
    const { el } = await render(noteRecord('pots', 'Pots'), [
      run('putback-r1', 'Put back “Filed Lovers vase here”', ['pots']),
      run('r1', 'Filed Lovers vase here', ['pots']),
    ]);
    const items = [...el.querySelectorAll('[aria-labelledby="claude-changes"] > li')];
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('app-put-back button')?.textContent).toContain('Put back');
    expect(items[1].querySelector('app-put-back button')).toBeNull();
    expect(items[1].querySelector('app-put-back')?.textContent?.trim()).toBe('Put back');
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

  describe('Instructions for Claude as they are typed (#200)', () => {
    const template: NoteRecord = {
      ...noteRecord('t1', 'Journal entry\n'),
      kind: 'template',
      instructions: 'Ask first.',
    };
    afterEach(() => vi.useRealTimers());

    async function typing() {
      const rendered = await render(template, []);
      vi.useFakeTimers();
      const box = rendered.el.querySelector('textarea')!;
      box.focus();
      box.value = 'Ask how';
      box.dispatchEvent(new Event('input'));
      return { ...rendered, box };
    }

    it('keeps every keystroke on the device at once, and writes after a pause', async () => {
      const { notes, box } = await typing();
      expect(notes.holdInstructions).toHaveBeenLastCalledWith('t1', 'Ask how');
      expect(notes.setInstructions).not.toHaveBeenCalled();
      box.value = 'Ask how the day went ';
      box.dispatchEvent(new Event('input'));
      expect(notes.holdInstructions).toHaveBeenLastCalledWith('t1', 'Ask how the day went');
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      expect(notes.setInstructions).toHaveBeenCalledTimes(1);
      expect(notes.setInstructions).toHaveBeenCalledWith('t1', 'Ask how the day went');
    });

    it('writes at once when the page goes with the field still focused', async () => {
      const { notes } = await typing();
      window.dispatchEvent(new Event('pagehide'));
      expect(notes.setInstructions).toHaveBeenCalledWith('t1', 'Ask how');
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      expect(notes.setInstructions).toHaveBeenCalledTimes(1);
    });

    it('writes at once on leaving the field, and only once', async () => {
      const { notes, box, fixture } = await typing();
      box.dispatchEvent(new Event('change'));
      expect(notes.setInstructions).toHaveBeenCalledTimes(1);
      fixture.componentRef.setInput('note', { ...template, instructions: 'Ask how' });
      box.dispatchEvent(new Event('change'));
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      expect(notes.setInstructions).toHaveBeenCalledTimes(1);
    });

    it('writes what waits when the back closes', async () => {
      const { notes, fixture } = await typing();
      fixture.destroy();
      expect(notes.setInstructions).toHaveBeenCalledWith('t1', 'Ask how');
    });

    it('never puts an earlier write’s snapshot over typing in the field', async () => {
      const { box, fixture } = await typing();
      box.value = 'Ask how the day went';
      fixture.componentRef.setInput('note', { ...template, instructions: 'Ask how' });
      fixture.detectChanges();
      expect(box.value).toBe('Ask how the day went');
      // Out of the field, it shows the stored words again.
      box.blur();
      fixture.componentRef.setInput('note', { ...template, instructions: 'Claude’s words.' });
      fixture.detectChanges();
      expect(box.value).toBe('Claude’s words.');
    });
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
    expect(done.el.textContent).not.toContain('Sent on arrival');
  });

  it('says a note was sent on arrival, not by Eric, queued and done (#214)', async () => {
    const queued = await render(
      { ...noteRecord('n5', 'Seeds'), sendState: 'queued', sentAt: 1, sentOnArrival: true },
      [],
    );
    expect(queued.el.querySelector('.arrival')?.textContent).toContain('Sent on arrival');
    expect(queued.el.textContent).toContain('with no ask, to be filed');
    TestBed.resetTestingModule();

    const done = await render(
      {
        ...noteRecord('n6', 'Moss'),
        sendState: 'done',
        sentAt: 1,
        sentOnArrival: true,
        sendOutcome: 'Linked it to pottery.',
      },
      [],
    );
    expect(done.el.textContent).toContain('Sent on arrival');
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
    agentRuns.next!({ status: 'working', steps: 2, since: Date.now() });
    TestBed.tick();
    expect(el.textContent).toContain('Doing it now: 2 steps so far.');
    expect(button(el, 'Do it now')).toBeUndefined();
    // A run lost with its function can be tried again (review on #152).
    agentRuns.next!({ status: 'working', steps: 2, since: Date.now() - 11 * 60_000 });
    TestBed.tick();
    expect(el.textContent).toContain('The run seems lost after 2 steps; try again.');
    expect(button(el, 'Do it now')).toBeTruthy();
    agentRuns.next!({ status: 'failed', steps: 2, error: 'the note was taken back' });
    TestBed.tick();
    expect(el.textContent).toContain('Could not do it now: the note was taken back');
    expect(button(el, 'Do it now')).toBeTruthy();
  });

  it('archives the note from its back, and restores it (#207)', async () => {
    const { el, notes, fixture } = await render(noteRecord('n1', 'Glaze notes'), []);
    button(el, 'Archive')!.click();
    expect(notes.setArchived).toHaveBeenCalledWith('n1', true);
    fixture.componentRef.setInput('note', { ...noteRecord('n1', 'Glaze notes'), archived: true });
    await fixture.whenStable();
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Archived');
    button(el, 'Restore')!.click();
    expect(notes.setArchived).toHaveBeenLastCalledWith('n1', false);
  });

  it('deletes the note after a one-line confirm, and leaves it (#217)', async () => {
    const { el, notes, fixture } = await render(noteRecord('n1', 'Glaze notes'), []);
    let left = 0;
    fixture.componentInstance.deleted.subscribe(() => left++);
    button(el, 'Delete')!.click();
    await fixture.whenStable();
    const confirm = el.querySelector('.confirm')!;
    expect(confirm.textContent).toContain('Delete this note? It stays in Trash for 30 days.');
    expect(button(el, 'Delete')).toBeFalsy();
    button(el, 'No')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.confirm')).toBeNull();
    expect(notes.setDeleted).not.toHaveBeenCalled();
    button(el, 'Delete')!.click();
    await fixture.whenStable();
    const yes = button(el, 'Yes')!;
    expect(yes.getAttribute('aria-describedby')).toBe('delete-note');
    yes.click();
    expect(notes.setDeleted).toHaveBeenCalledWith('n1', true);
    expect(left).toBe(1);
  });

  it('offers no Delete on the pantry, a meal plan or the context note (#217)', async () => {
    for (const kind of ['pantry', 'mealplan', 'context']) {
      TestBed.resetTestingModule();
      const { el } = await render({ ...noteRecord('k1', 'Kept'), kind }, []);
      expect(button(el, 'Archive')).toBeTruthy();
      expect(button(el, 'Delete')).toBeFalsy();
    }
  });

  it('offers no Delete on the current grocery list, only on an older one (#217)', async () => {
    const template: NoteRecord = {
      ...noteRecord('t1', 'Shopping list'),
      kind: 'template',
      templateMode: 'living',
    };
    const list = (id: string, archived = false): NoteRecord => ({
      ...noteRecord(id, '- [ ] limes\n'),
      fromTemplate: 't1',
      archived,
    });
    const current = await render(list('shopping-2026-11-09'), [], [template]);
    expect(button(current.el, 'Archive')).toBeTruthy();
    expect(button(current.el, 'Delete')).toBeFalsy();
    TestBed.resetTestingModule();
    const older = await render(
      list('shopping-2026-11-02', true),
      [],
      [template, list('shopping-2026-11-09')],
    );
    expect(button(older.el, 'Delete')).toBeTruthy();
  });

  it('says on a grocery list’s back which of the week’s dinners need each item (#207)', async () => {
    const template: NoteRecord = {
      ...noteRecord('t1', 'Shopping list'),
      kind: 'template',
      templateMode: 'living',
    };
    const list: NoteRecord = {
      ...noteRecord(
        'shopping-2026-10-19',
        '## Produce\n\n- [ ] 2 onions, sliced\n- [ ] limes\n- [x] 400 g tomatoes\n',
      ),
      title: 'Shopping list, week of Oct 19',
      fromTemplate: 't1',
      periodStart: '2026-10-19',
    };
    const plan: NoteRecord = {
      ...noteRecord(
        'meals-2026-10-19',
        '- [ ] Mon dinner: [[Shakshuka]]\n- [ ] Tue dinner: delivery\n- [ ] Thu dinner: [[Chili]]\n',
      ),
      kind: 'mealplan',
      periodStart: '2026-10-19',
    };
    const recipe = (id: string, title: string, body: string): NoteRecord => ({
      ...noteRecord(id, body),
      kind: 'recipe',
      title,
    });
    const { el } = await render(
      list,
      [],
      [
        template,
        plan,
        recipe('r1', 'Shakshuka', '## Ingredients\n\n- 2 onions\n- 400 g tomatoes\n'),
        recipe('r2', 'Chili', '## Ingredients\n\n- onions\n- beans\n'),
      ],
    );
    // Kitchen off, a list is a plain note.
    expect(el.textContent).not.toContain('For the week of');
    (TestBed.inject(ModulesService) as unknown as FakeModules).set('kitchen', true);
    await TestBed.inject(ApplicationRef).whenStable();
    expect(el.querySelector('#list-for')!.textContent).toBe('For the week of Oct 19');
    const items = [...el.querySelectorAll('[aria-labelledby="list-for"] li')].map((li) =>
      li.textContent!.trim(),
    );
    // Limes, which no dinner needs, and the ticked tomatoes are left out.
    expect(items).toEqual(['2 onions, sliced: Shakshuka (Mon), Chili (Thu)']);
  });
});
