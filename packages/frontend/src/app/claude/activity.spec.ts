import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NotesService } from '../notes/notes.service';
import { FakeAuthService, FakeNotes, fakeFirebase, noteRecord } from '../testing/fakes';
import { ACTIVITY_API, Activity, type ActivityApi } from './activity';

const at = (ms: number) => ({ toMillis: () => ms });

async function render() {
  let push: Parameters<ActivityApi['listen']>[2] = () => undefined;
  const api = {
    listen: vi.fn((_db, _path, next) => {
      push = next;
      return vi.fn();
    }),
  } satisfies ActivityApi;
  const auth = new FakeAuthService();
  auth.user.set({ uid: 'u1' } as User);
  const notes = new FakeNotes();
  notes.signIn([
    { ...noteRecord('m1', 'Kiln log, merged'), title: 'Kiln log' },
    { ...noteRecord('a', 'Firing notes'), archived: true },
  ]);
  await TestBed.configureTestingModule({
    imports: [Activity],
    providers: [
      provideRouter([]),
      { provide: ACTIVITY_API, useValue: api },
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: auth },
      { provide: NotesService, useValue: notes },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Activity);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return {
    el,
    api,
    auth,
    fixture,
    async push(docs: { id: string; data: Record<string, unknown> }[]) {
      push(docs);
      await fixture.whenStable();
    },
  };
}

describe('Activity', () => {
  it("listens to the owner's runs, loading first, then says when there are none", async () => {
    const { el, api, push } = await render();
    expect(api.listen).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/activity',
      expect.any(Function),
      expect.any(Function),
    );
    expect(el.textContent).toContain('Loading…');
    await push([]);
    expect(el.textContent).toContain('Nothing yet.');
  });

  it('lists each run with the notes it touched, their History, and reminders', async () => {
    const { el, push } = await render();
    await push([
      {
        id: 'r2',
        data: {
          at: at(Date.parse('2026-10-07T03:00:00Z')),
          tool: 'merge_notes',
          summary: 'Merged 2 notes into one',
          notes: [
            { id: 'm1', title: 'Kiln' },
            { id: 'a', title: 'Firing notes' },
          ],
          reminders: [],
        },
      },
      {
        id: 'r1',
        data: {
          at: at(Date.parse('2026-10-07T02:00:00Z')),
          tool: 'create_reminder',
          summary: 'Made a reminder',
          notes: [],
          reminders: [{ id: 'x', title: 'Water seeds' }],
        },
      },
    ]);
    const runs = [...el.querySelectorAll('.runs > li')];
    expect(runs).toHaveLength(2);
    expect(runs[0].querySelector('.summary')?.textContent).toContain('Merged 2 notes into one');
    const links = [...runs[0].querySelectorAll('a')].map((a) => [
      a.textContent?.trim(),
      a.getAttribute('href'),
    ]);
    // The title now, not as it was; an archived original says so.
    expect(links).toEqual([
      ['Kiln log', '/n/m1'],
      ['History of Kiln log', '/history?note=m1'],
      ['Firing notes', '/n/a'],
      ['History of Firing notes', '/history?note=a'],
    ]);
    expect(runs[0].textContent).toContain('archived');
    expect(runs[1].querySelector('a')?.getAttribute('href')).toBe('/right-now');
    expect(runs[1].textContent).toContain('Water seeds');
  });

  it('stops listening when the owner signs out', async () => {
    const { api, auth, fixture } = await render();
    const stop = api.listen.mock.results[0].value as ReturnType<typeof vi.fn>;
    auth.user.set(null);
    await fixture.whenStable();
    expect(stop).toHaveBeenCalled();
  });
});
