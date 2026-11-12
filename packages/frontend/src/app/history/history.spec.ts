import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type DataKey, aadFor, newDataKey, sealText } from '@mossgoblin/schema';
import { Router, provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { CaptureService } from '../capture/capture.service';
import { FIREBASE } from '../firebase';
import { NoteKeyService } from '../notes/note-key.service';
import { NotesService } from '../notes/notes.service';
import { FakeAuthService, FakeNotes, fakeFirebase, noteRecord } from '../testing/fakes';
import { HISTORY_API, History, type HistoryApi, reasonLabel } from './history';

const at = (ms: number) => ({ toMillis: () => ms });

async function render(noteId = 'n1') {
  let push: Parameters<HistoryApi['listen']>[2] = () => undefined;
  const api = {
    listen: vi.fn((_db, _path, next) => {
      push = next;
      return vi.fn();
    }),
  } satisfies HistoryApi;
  const auth = new FakeAuthService();
  auth.user.set({ uid: 'u1' } as User);
  const notes = new FakeNotes();
  notes.signIn([noteRecord('n1', 'Groceries now')]);
  const capture = { restore: vi.fn() };
  const key = signal<DataKey | undefined>(undefined);
  await TestBed.configureTestingModule({
    imports: [History],
    providers: [
      provideRouter([{ path: 'history', component: History }]),
      { provide: HISTORY_API, useValue: api },
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: auth },
      { provide: NotesService, useValue: notes },
      { provide: CaptureService, useValue: capture },
      { provide: NoteKeyService, useValue: { key } },
    ],
  }).compileComponents();
  const router = TestBed.inject(Router);
  await router.navigateByUrl(`/history?note=${noteId}`);
  const fixture = TestBed.createComponent(History);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return {
    el,
    api,
    capture,
    router,
    async setKey(k: DataKey | undefined) {
      key.set(k);
      await fixture.whenStable();
    },
    async push(docs: { id: string; data: Record<string, unknown> }[]) {
      push(docs);
      await fixture.whenStable();
    },
  };
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('History', () => {
  it("listens to the note's history and says so when there is none", async () => {
    const { el, api, push } = await render();
    expect(api.listen).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/notes/n1/history',
      expect.any(Function),
      expect.any(Function),
    );
    await push([]);
    expect(el.textContent).toContain('No earlier versions yet.');
    expect(el.textContent).toContain('Groceries now');
  });

  it('lists versions with why they were kept, opens one, and restores it', async () => {
    const { el, push, capture, router } = await render();
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await push([
      {
        id: 'v2',
        data: {
          body: 'Groceries: milk, eggs',
          updatedBy: 'user',
          reason: 'device',
          updatedAt: at(2),
          savedAt: at(3),
        },
      },
    ]);
    expect(el.textContent).toContain('Written over from another device');
    const version = button(el, 'Groceries: milk, eggs')!;
    version.click();
    await new Promise((r) => setTimeout(r));
    TestBed.tick();
    expect(version.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('pre')?.textContent).toBe('Groceries: milk, eggs');
    button(el, 'Restore this version')!.click();
    expect(capture.restore).toHaveBeenCalledWith('n1', 'Groceries: milk, eggs');
    expect(navigate).toHaveBeenCalledWith(['/n', 'n1']);
  });
});

describe('reasonLabel', () => {
  it('says whose version an author change kept', () => {
    const v = { id: 'v', body: '', reason: 'author' as const, agent: 'Claude' };
    expect(reasonLabel({ ...v, updatedBy: 'claude' })).toBe("Claude's version, before your edit");
    expect(reasonLabel({ ...v, updatedBy: 'claude', agent: 'Gemini CLI' })).toBe(
      "Gemini CLI's version, before your edit",
    );
    expect(reasonLabel({ ...v, updatedBy: 'user' })).toBe('Before an assistant edited it');
    expect(reasonLabel({ ...v, updatedBy: 'user', reason: 'deleted' })).toBe(
      'Before the note was deleted',
    );
  });

  describe('a sealed version (note encryption step 3a)', () => {
    const KEY = newDataKey();
    // A version is a copy of the note's body: sealed with the note's aad.
    const sealedVersion = {
      id: 'v1',
      data: {
        body: sealText(KEY, aadFor('u1', 'n1', 'body'), 'Groceries: milk, eggs'),
        updatedBy: 'user',
        reason: 'device',
        updatedAt: at(Date.UTC(2026, 9, 6, 10)),
      },
    };

    it('shows as sealed, never as its sealed text, and cannot be restored', async () => {
      const { el, push, capture, setKey } = await render();
      await push([sealedVersion]);
      expect(el.textContent).not.toContain('\uE000');
      button(el, 'Sealed')!.click();
      // Still no key: drawn again with the version open.
      await setKey(undefined);
      expect(el.textContent).toContain('This version is sealed');
      expect(button(el, 'Restore this version')).toBeUndefined();
      expect(capture.restore).not.toHaveBeenCalled();
    });

    it('opens with the note’s own key and aad once the key is here', async () => {
      const { el, push, setKey, capture } = await render();
      await push([sealedVersion]);
      await setKey(KEY);
      expect(el.textContent).toContain('Groceries: milk, eggs');
      button(el, 'Groceries: milk, eggs')!.click();
      await setKey(KEY);
      button(el, 'Restore this version')!.click();
      expect(capture.restore).toHaveBeenCalledWith('n1', 'Groceries: milk, eggs');
    });
  });
});
