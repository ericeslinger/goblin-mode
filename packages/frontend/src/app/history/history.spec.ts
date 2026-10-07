import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { CaptureService } from '../capture/capture.service';
import { FIREBASE } from '../firebase';
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
  await TestBed.configureTestingModule({
    imports: [History],
    providers: [
      provideRouter([{ path: 'history', component: History }]),
      { provide: HISTORY_API, useValue: api },
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: auth },
      { provide: NotesService, useValue: notes },
      { provide: CaptureService, useValue: capture },
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
    const v = { id: 'v', body: '', reason: 'author' as const };
    expect(reasonLabel({ ...v, updatedBy: 'claude' })).toBe("Claude's version, before your edit");
    expect(reasonLabel({ ...v, updatedBy: 'user' })).toBe('Before Claude edited it');
    expect(reasonLabel({ ...v, updatedBy: 'user', reason: 'deleted' })).toBe(
      'Before the note was deleted',
    );
  });
});
