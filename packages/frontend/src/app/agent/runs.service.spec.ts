import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type DataKey, aadFor, newDataKey, recordAadFor, sealText } from '@mossgoblin/schema';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NoteKeyService } from '../notes/note-key.service';
import { FakeAuthService, fakeFirebase } from '../testing/fakes';
import { SETTINGS_API, type SettingsApi } from '../theme/theme-sync.service';
import { RunsService, type RunView, toRunView } from './runs.service';

// Note encryption step 3e (2026-11-13): a run's outcome may be sealed,
// bound to the run, and opens on the note's back once the key is here.

const dataKey = newDataKey();
const sealed = (runId: string, text: string) =>
  sealText(dataKey, recordAadFor('u1', 'runs', runId, 'outcome'), text);

function setup(key = signal<DataKey | undefined>(undefined)) {
  let push: (data: Record<string, unknown> | undefined) => void = () => undefined;
  const stop = vi.fn();
  const settings = {
    listen: vi.fn((_db, _path, next) => {
      push = next;
      return stop;
    }),
  } as unknown as SettingsApi;
  const auth = new FakeAuthService();
  auth.user.set({ uid: 'u1' } as User);
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_API, useValue: settings },
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: auth },
      { provide: NoteKeyService, useValue: { key } },
    ],
  });
  const service = TestBed.inject(RunsService);
  const seen: (RunView | undefined)[] = [];
  const off = service.watch('r1', (run) => seen.push(run));
  return {
    key,
    seen,
    off,
    stop,
    settings,
    push(data: Record<string, unknown> | undefined) {
      push(data);
      TestBed.tick();
    },
  };
}

describe('toRunView', () => {
  it('passes a plain outcome through', () => {
    expect(toRunView({ status: 'done', steps: [], outcome: 'Filed it' })).toMatchObject({
      status: 'done',
      outcome: 'Filed it',
    });
  });

  it('opens a sealed outcome, or says sealed and leaves it out', () => {
    const data = { status: 'done', steps: [], outcome: sealed('r1', 'Filed it') };
    expect(toRunView(data, () => 'Filed it')).toMatchObject({ outcome: 'Filed it' });
    const locked = toRunView(data);
    expect(locked).toMatchObject({ status: 'done', sealed: true });
    expect(locked.outcome).toBeUndefined();
  });
});

describe('RunsService.watch, a sealed outcome (step 3e)', () => {
  it('listens to the run and shows a plain one as before', () => {
    const { settings, push, seen } = setup();
    expect(settings.listen).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/runs/r1',
      expect.any(Function),
      expect.any(Function),
    );
    push({ status: 'done', steps: [{}], outcome: 'Filed it' });
    expect(seen.at(-1)).toMatchObject({ status: 'done', steps: 1, outcome: 'Filed it' });
  });

  it('opens a sealed outcome when the key arrives after the run did', () => {
    const { key, push, seen } = setup();
    push({ status: 'done', steps: [], outcome: sealed('r1', 'Filed it under Pottery') });
    expect(seen.at(-1)).toMatchObject({ status: 'done', sealed: true });
    expect(JSON.stringify(seen)).not.toContain('');
    key.set(dataKey);
    TestBed.tick();
    expect(seen.at(-1)).toMatchObject({ outcome: 'Filed it under Pottery' });
    expect(seen.at(-1)?.sealed).toBeUndefined();
  });

  it('does not open an outcome sealed for another run or for a note', () => {
    const { push, seen } = setup(signal<DataKey | undefined>(dataKey));
    push({ status: 'done', steps: [], outcome: sealed('r2', 'moved') });
    expect(seen.at(-1)).toMatchObject({ sealed: true });
    push({
      status: 'done',
      steps: [],
      outcome: sealText(dataKey, aadFor('u1', 'r1', 'sendOutcome'), 'from the note'),
    });
    expect(seen.at(-1)).toMatchObject({ sealed: true });
  });

  it('stops listening, and follows the key no more, once stopped', () => {
    const { key, push, seen, off, stop } = setup();
    push({ status: 'done', steps: [], outcome: sealed('r1', 'x') });
    off();
    expect(stop).toHaveBeenCalled();
    const n = seen.length;
    key.set(dataKey);
    TestBed.tick();
    expect(seen.length).toBe(n);
  });
});
