import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { ACTIVITY_API, type ActivityApi } from '../claude/activity';
import { LinksService } from '../links/links.service';
import { NotesService, type NoteRecord } from '../notes/notes.service';
import {
  FakeAuthService,
  FakeNotes,
  noteRecord,
  remindersTestProviders,
  FakeRemindersApi,
} from '../testing/fakes';
import { NoteBack } from './note-back';

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
  return { el: fixture.nativeElement as HTMLElement, notes };
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
    expect(el.textContent).toContain('Nothing Claude did lately touched this note.');
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
});
