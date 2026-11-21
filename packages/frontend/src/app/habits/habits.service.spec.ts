import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { ModulesService } from '../modules/modules.service';
import { TICK_MS, UNDO_MS } from '../reminders/reminders.service';
import {
  FakeHabitsApi,
  type FakeModules,
  FakeRemindersApi,
  habitDoc,
  remindersTestProviders,
  stamp,
} from '../testing/fakes';
import { HABITS_API, HabitsService } from './habits.service';

const DAY = 24 * 60 * 60 * 1000;
// 2026-10-06 10:00 in New York, a Tuesday.
const NOW = Date.parse('2026-10-06T14:00:00Z');

function setup(
  { on = true, user = { uid: 'u1' } as User | null | undefined, now = NOW } = {} as {
    on?: boolean;
    user?: User | null | undefined;
    now?: number;
  },
) {
  const api = new FakeHabitsApi();
  const auth = signal<User | null | undefined>(user);
  let clock = now;
  TestBed.configureTestingModule({
    providers: [
      ...remindersTestProviders(new FakeRemindersApi(), () => clock),
      { provide: HABITS_API, useValue: api },
      { provide: AuthService, useValue: { user: auth } },
    ],
  });
  const modules = TestBed.inject(ModulesService) as unknown as FakeModules;
  if (on) modules.set('habits', true);
  const habits = TestBed.inject(HabitsService);
  TestBed.tick();
  return {
    habits,
    api,
    auth,
    modules,
    setNow: (t: number) => (clock = t),
    /** The habits' snapshot, then every log listened to as given, else empty. */
    push(
      docs: ReturnType<typeof habitDoc>[],
      logs: Record<string, Record<string, { state: 'done' | 'skipped' }>> = {},
    ) {
      api.pushHabits(docs);
      TestBed.tick();
      for (const id of api.logs.keys()) api.pushLog(id, logs[id]);
      TestBed.tick();
    },
  };
}

/** The last write, its timestamps read back as millis. */
function lastWrite(api: FakeHabitsApi) {
  const [, path, data, merge] = api.set.mock.lastCall!;
  return { path, data: plain(data), merge };
}

function plain(v: unknown): unknown {
  if (v && typeof v === 'object') {
    const ms = (v as { toMillis?: () => number }).toMillis?.();
    if (ms !== undefined) return ms;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

/** The server's refusal, as Firestore rejects a write it will not take. */
const refusal = () =>
  Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });

/** Lets settled write promises run their handlers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

describe('HabitsService (#324)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads nothing while the module is off, and the habits once it is on', () => {
    const { api, modules } = setup({ on: false });
    expect(api.listenHabits).not.toHaveBeenCalled();
    modules.set('habits', true);
    TestBed.tick();
    expect(api.listenHabits).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/habits',
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('listens to the month logs the strip needs, by their derived ids, at most two', () => {
    const { api } = setup();
    api.pushHabits([habitDoc('floss', { name: 'Floss' })]);
    TestBed.tick();
    // Tuesday the 6th: the strip reaches back to the 30th of September.
    expect([...api.logs.keys()]).toEqual(['floss_2026-09', 'floss_2026-10']);
  });

  it('lists today’s due habits by time, then name, and leaves archived ones off', () => {
    const { habits, push } = setup();
    push([
      habitDoc('b', { name: 'Walk' }),
      habitDoc('a', { name: 'Stretch', time: '07:30' }),
      habitDoc('c', { name: 'Read' }),
      habitDoc('z', { name: 'Old habit', archived: true }),
    ]);
    expect(habits.toDo().map((h) => h.name)).toEqual(['Stretch', 'Read', 'Walk']);
    expect(habits.archived().map((h) => h.name)).toEqual(['Old habit']);
  });

  it('writes a tick to the month log’s derived id and the day’s key, merged', () => {
    const { habits, api, push } = setup();
    push([habitDoc('floss', { name: 'Floss' })]);
    habits.log(habits.toDo()[0], '2026-10-06', 'done');
    expect(lastWrite(api)).toEqual({
      path: 'users/u1/habitLogs/floss_2026-10',
      merge: true,
      data: {
        habit: 'floss',
        month: '2026-10',
        days: { '06': { state: 'done', at: NOW, answer: 'DELETE', noteId: 'DELETE' } },
        updatedAt: NOW,
      },
    });
  });

  it('takes a done or skipped habit off the list for the settled line, with Undo', () => {
    const { habits, api, push } = setup();
    push([habitDoc('floss', { name: 'Floss' }), habitDoc('run', { name: 'Run' })]);
    const floss = habits.toDo().find((h) => h.id === 'floss')!;
    habits.log(floss, '2026-10-06', 'done');
    expect(habits.undoable()?.message).toBe('Floss: done');
    // The cache gives the write back at once, as it does offline.
    api.pushLog('floss_2026-10', { '06': { state: 'done' } });
    TestBed.tick();
    expect(habits.toDo().map((h) => h.id)).toEqual(['run']);
    expect(habits.settled().map((h) => [h.id, h.state])).toEqual([['floss', 'done']]);

    habits.undo();
    expect(lastWrite(api)).toMatchObject({
      path: 'users/u1/habitLogs/floss_2026-10',
      data: { days: { '06': 'DELETE' } },
      merge: true,
    });
    expect(habits.undoable()).toBeNull();
  });

  it('puts back what was there before on Undo, and lets the offer lapse', () => {
    const { habits, api, push } = setup();
    push([habitDoc('floss', { name: 'Floss' })], {
      'floss_2026-10': { '06': { state: 'skipped' } },
    });
    habits.log(habits.placed()[0], '2026-10-06', 'done');
    habits.undo();
    expect(lastWrite(api).data).toMatchObject({
      days: { '06': { state: 'skipped', answer: 'DELETE', noteId: 'DELETE' } },
    });
    habits.log(habits.placed()[0], '2026-10-06', 'done');
    vi.advanceTimersByTime(UNDO_MS);
    expect(habits.undoable()).toBeNull();
  });

  it('keeps a tick made before the gardener is known, and writes it once he is', () => {
    const { habits, api, auth, push } = setup();
    push([habitDoc('floss', { name: 'Floss' })]);
    const floss = habits.placed()[0];
    // The session is being restored again (a reload offline).
    auth.set(undefined);
    TestBed.tick();
    habits.log(floss, '2026-10-06', 'done');
    expect(api.set).not.toHaveBeenCalled();
    auth.set({ uid: 'u1' } as User);
    TestBed.tick();
    expect(lastWrite(api)).toMatchObject({
      path: 'users/u1/habitLogs/floss_2026-10',
      data: { days: { '06': { state: 'done' } } },
    });
  });

  it('never waits on a write: a tick offline is kept while the next is made', () => {
    const { habits, api, push } = setup();
    // Offline, the cache takes the write and its promise waits.
    api.set.mockImplementation(() => new Promise<void>(() => undefined));
    push([habitDoc('floss', { name: 'Floss' }), habitDoc('run', { name: 'Run' })]);
    const [floss, run] = habits.placed();
    habits.log(floss, '2026-10-06', 'done');
    habits.log(run, '2026-10-06', 'skipped');
    expect(api.set).toHaveBeenCalledTimes(2);
  });

  it('lets a write go while signed out', () => {
    const { habits, api } = setup({ user: null });
    habits.add({ name: 'Floss' });
    expect(api.set).not.toHaveBeenCalled();
  });

  it('moves to the next day at midnight while open', () => {
    const late = Date.parse('2026-11-01T03:59:00Z'); // 23:59 on Oct 31 in New York
    const { habits, api, setNow, push } = setup({ now: late });
    push([habitDoc('floss', { name: 'Floss' })], {
      'floss_2026-10': { '31': { state: 'done' } },
    });
    expect(habits.today()).toBe('2026-10-31');
    expect(habits.toDo()).toEqual([]);
    setNow(late + 2 * 60_000);
    vi.advanceTimersByTime(TICK_MS);
    TestBed.tick();
    expect(habits.today()).toBe('2026-11-01');
    // The new month's log is read; done yesterday, due again today.
    expect([...api.logs.keys()]).toEqual(['floss_2026-10', 'floss_2026-11']);
    api.pushLog('floss_2026-11');
    TestBed.tick();
    expect(habits.toDo().map((h) => h.id)).toEqual(['floss']);
    expect(habits.placed()[0].yesterday).toBe('done');
  });

  it('shows a weekly habit on each day of its week until it is done', () => {
    const { habits, setNow, push, api } = setup();
    const weekly = habitDoc('pots', { name: 'Clean the pots', schedule: 'weekly' });
    // Tuesday the 6th, in the week from Monday the 5th: nothing yet.
    push([weekly]);
    expect(habits.toDo().map((h) => h.id)).toEqual(['pots']);
    // Done on Tuesday: shown as done that day, then off the list.
    api.pushLog('pots_2026-10', { '06': { state: 'done' } });
    TestBed.tick();
    expect(habits.settled().map((h) => h.id)).toEqual(['pots']);
    setNow(NOW + DAY);
    vi.advanceTimersByTime(TICK_MS);
    TestBed.tick();
    expect(habits.placed()[0].due).toBe(false);
    expect(habits.toDo()).toEqual([]);
    // The week after, due again.
    setNow(NOW + 6 * DAY);
    vi.advanceTimersByTime(TICK_MS);
    TestBed.tick();
    expect(habits.toDo().map((h) => h.id)).toEqual(['pots']);
  });

  it('counts the streak past an unlogged yesterday, and offers yesterday', () => {
    const { habits, push } = setup();
    push([habitDoc('floss', { name: 'Floss', createdAt: NOW - 10 * DAY })], {
      'floss_2026-10': { '03': { state: 'done' }, '04': { state: 'done' } },
    });
    const floss = habits.placed()[0];
    // Today open and yesterday (the 5th) empty are both passed over.
    expect(floss.streak).toEqual({ count: 2, complete: true });
    expect(floss.yesterdayOpen).toBe(true);
    expect(floss.strip.map((d) => d.state)).toEqual([
      'missed',
      'missed',
      'missed',
      'done',
      'done',
      // Yesterday is empty but can still be logged: open, not missed.
      'open',
      'open',
    ]);
  });

  it('keeps the good days of a month log and drops a bad one, not the month', () => {
    const { habits, api } = setup();
    api.pushHabits([habitDoc('floss', { name: 'Floss', createdAt: NOW - 10 * DAY })]);
    TestBed.tick();
    api.pushLog('floss_2026-09');
    api.logs.get('floss_2026-10')!({
      days: {
        '03': { state: 'done', at: stamp(NOW) },
        '04': { state: 'maybe', at: stamp(NOW) }, // no such state
        '05': { state: 'done' }, // no stamp
        '32': { state: 'done', at: stamp(NOW) }, // no such day
        '06': { state: 'skipped', at: stamp(NOW), answer: 'plain words' }, // a skip holds none
      },
    });
    TestBed.tick();
    const floss = habits.placed()[0];
    expect(floss.strip.slice(3).map((d) => d.state)).toEqual(['done', 'missed', 'open', 'open']);
    // The bad skip on the 6th is not read: nothing today.
    expect(floss.today).toBeUndefined();
    expect(floss.state).toBe('none');
  });

  it('passes over a habit document that does not parse, keeping the rest', () => {
    const { habits, push } = setup();
    push([
      habitDoc('floss', { name: 'Floss' }),
      habitDoc('bad', { name: '' }), // a name is 1 to 80
      habitDoc('worse', { name: 'Mood', answer: 'choice' }), // a choice needs its choices
      habitDoc('under_score', { name: 'Run' }), // not a habit's id
      { id: 'bare', data: { name: 'Nothing else' } },
    ]);
    expect(habits.placed().map((h) => h.id)).toEqual(['floss']);
    expect(habits.loaded()).toBe(true);
  });

  it('offers no yesterday for a habit made today', () => {
    const { habits, push } = setup();
    push([habitDoc('floss', { name: 'Floss', createdAt: NOW - 60_000 })]);
    expect(habits.placed()[0].yesterdayLoggable).toBe(false);
    expect(
      habits
        .placed()[0]
        .strip.slice(0, 6)
        .every((d) => d.state === 'before'),
    ).toBe(true);
  });

  it('reads one month more for a streak only while a screen shows it', () => {
    // Saturday the 10th: the strip and its week are October's alone.
    const { habits, api, push } = setup({ now: NOW + 4 * DAY });
    const days = Object.fromEntries(
      ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((d) => [
        d,
        { state: 'done' as const },
      ]),
    );
    push([habitDoc('floss', { name: 'Floss', createdAt: NOW - 90 * DAY })], {
      'floss_2026-10': days,
    });
    expect([...api.logs.keys()]).toEqual(['floss_2026-10']);
    expect(habits.placed()[0].streak).toEqual({ count: 9, complete: false });
    TestBed.tick();
    expect([...api.logs.keys()]).toEqual(['floss_2026-10']);
    const stop = habits.showStreaks();
    TestBed.tick();
    expect([...api.logs.keys()]).toContain('floss_2026-09');
    // Unknown until September is heard.
    expect(habits.placed()[0].streak).toBeUndefined();
    api.pushLog('floss_2026-09', { '30': { state: 'done' } });
    TestBed.tick();
    expect(habits.placed()[0].streak).toEqual({ count: 10, complete: true });
    stop();
  });

  it('adds a daily, done-only habit with a generated id, offline as ever', () => {
    const { habits, api } = setup();
    const id = habits.add({ name: '  Stretch  ', time: '07:30' });
    const { path, data, merge } = lastWrite(api);
    expect(path).toBe(`users/u1/habits/${id}`);
    expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(merge).toBe(false);
    expect(data).toEqual({
      name: 'Stretch',
      schedule: 'daily',
      time: '07:30',
      tz: 'America/New_York',
      answer: 'done',
      nudge: false,
      archived: false,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: 'user',
    });
    expect(habits.add({ name: '   ' })).toBeUndefined();
  });

  it('renames, sets or clears the time, and archives with merged writes', () => {
    const { habits, api } = setup();
    habits.rename('floss', ' Floss twice ');
    expect(lastWrite(api)).toEqual({
      path: 'users/u1/habits/floss',
      data: { name: 'Floss twice', updatedAt: NOW },
      merge: true,
    });
    habits.setTime('floss', '21:00');
    expect(lastWrite(api).data).toEqual({ time: '21:00', tz: 'America/New_York', updatedAt: NOW });
    habits.setTime('floss', undefined);
    expect(lastWrite(api).data).toMatchObject({ time: 'DELETE' });
    habits.archive('floss', true);
    expect(lastWrite(api).data).toEqual({ archived: true, updatedAt: NOW });
  });

  it('takes an archived habit off Right Now', () => {
    const { habits, api, push } = setup();
    push([habitDoc('floss', { name: 'Floss' })]);
    expect(habits.toDo()).toHaveLength(1);
    api.pushHabits([habitDoc('floss', { name: 'Floss', archived: true })]);
    TestBed.tick();
    expect(habits.toDo()).toEqual([]);
    expect(habits.archived().map((h) => h.id)).toEqual(['floss']);
  });

  it('logs only today or yesterday', () => {
    const { habits, api, push } = setup();
    push([habitDoc('floss', { name: 'Floss' })]);
    habits.log(habits.placed()[0], '2026-10-04', 'done');
    expect(api.set).not.toHaveBeenCalled();
    habits.log(habits.placed()[0], '2026-10-05', 'skipped');
    expect(lastWrite(api).data).toMatchObject({ days: { '05': { state: 'skipped' } } });
    expect(habits.undoable()?.message).toBe('Floss: skipped yesterday');
  });

  it('shows a habit with another kind of answer, and ticks it done', () => {
    const { habits, api, push } = setup();
    push([habitDoc('mood', { name: 'Mood', answer: 'choice', choices: ['good', 'low'] })]);
    expect(habits.toDo().map((h) => h.id)).toEqual(['mood']);
    habits.log(habits.toDo()[0], '2026-10-06', 'done');
    expect(lastWrite(api).path).toBe('users/u1/habitLogs/mood_2026-10');
  });

  describe('a write the server refuses (review of #327)', () => {
    beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));

    it('says which habit and day, logs it, and leaves no Undo for a tick that is gone', async () => {
      const { habits, api, push } = setup();
      push([habitDoc('floss', { name: 'Floss' })]);
      api.set.mockReturnValueOnce(Promise.reject(refusal()));
      habits.log(habits.toDo()[0], '2026-10-06', 'done');
      expect(habits.undoable()?.message).toBe('Floss: done');
      await settle();
      expect(habits.refusals()).toEqual([
        {
          key: 'log:floss:2026-10-06',
          habit: 'floss',
          day: '2026-10-06',
          name: 'Floss',
          message: 'Floss could not be saved for today.',
        },
      ]);
      expect(console.error).toHaveBeenCalledWith('habit write failed', expect.any(Error));
      // Firestore puts the cache back: nothing claims the tick was made.
      expect(habits.undoable()).toBeNull();
      expect(habits.toDo().map((h) => h.id)).toEqual(['floss']);
      expect(api.set).toHaveBeenCalledTimes(1);
    });

    it('sends the same write again on Try again, and says so again if refused', async () => {
      const { habits, api, push } = setup();
      push([habitDoc('floss', { name: 'Floss' })]);
      api.set.mockReturnValueOnce(Promise.reject(refusal()));
      habits.log(habits.toDo()[0], '2026-10-05', 'skipped');
      await settle();
      expect(habits.refusals()[0].message).toBe('Floss could not be saved for yesterday.');
      const first = api.set.mock.lastCall!;
      api.set.mockReturnValueOnce(Promise.reject(refusal()));
      habits.retry('log:floss:2026-10-05');
      expect(api.set).toHaveBeenCalledTimes(2);
      expect(api.set.mock.lastCall).toEqual(first);
      // Sent, and not refused yet: the line is put away meanwhile.
      expect(habits.refusals()).toEqual([]);
      await settle();
      expect(habits.refusals().map((r) => r.key)).toEqual(['log:floss:2026-10-05']);
    });

    it('clears the line once the same thing is next saved', async () => {
      const { habits, api, push } = setup();
      push([habitDoc('floss', { name: 'Floss' }), habitDoc('run', { name: 'Run' })]);
      api.set.mockReturnValueOnce(Promise.reject(refusal()));
      api.set.mockReturnValueOnce(Promise.reject(refusal()));
      const [floss, run] = habits.placed();
      habits.log(floss, '2026-10-06', 'done');
      habits.log(run, '2026-10-06', 'done');
      await settle();
      expect(habits.refusals().map((r) => r.name)).toEqual(['Floss', 'Run']);
      // Ticked again by hand, and saved this time.
      habits.log(floss, '2026-10-06', 'done');
      await settle();
      expect(habits.refusals().map((r) => r.name)).toEqual(['Run']);
      habits.dismiss('log:run:2026-10-06');
      expect(habits.refusals()).toEqual([]);
      expect(api.set).toHaveBeenCalledTimes(3);
    });

    it('says nothing of a write waiting offline', async () => {
      const { habits, api, push } = setup();
      api.set.mockImplementation(() => new Promise<void>(() => undefined));
      push([habitDoc('floss', { name: 'Floss' })]);
      habits.log(habits.toDo()[0], '2026-10-06', 'done');
      await settle();
      vi.advanceTimersByTime(60_000);
      await settle();
      expect(habits.refusals()).toEqual([]);
      expect(console.error).not.toHaveBeenCalled();
    });

    it('names a refused habit, or a refused change to one', async () => {
      const { habits, api, push } = setup();
      push([habitDoc('floss', { name: 'Floss' })]);
      api.set.mockReturnValueOnce(Promise.reject(refusal()));
      api.set.mockReturnValueOnce(Promise.reject(refusal()));
      const id = habits.add({ name: 'Stretch' })!;
      habits.rename('floss', 'Floss twice');
      await settle();
      expect(habits.refusals().map((r) => [r.key, r.message])).toEqual([
        [`habit:${id}`, 'Stretch could not be saved.'],
        ['habit:floss', 'The change to Floss could not be saved.'],
      ]);
    });
  });
});
