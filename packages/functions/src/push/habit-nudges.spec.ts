import { type Habit, type HabitEntry, habitsConfig } from '@mossgoblin/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  type HabitsModule,
  type NudgeStore,
  type NudgingHabit,
  nudgeMessage,
  nudgeWakeName,
  sendNudges,
  wakeForNudge,
  wakeUpcomingNudges,
} from './habit-nudges';
import type { Device, SendResult } from './send-due';
import type { WakeQueue } from './wake';

const NY = 'America/New_York';
/** 21:00 in New York on Saturday 2026-11-21. */
const AT = Date.parse('2026-11-22T02:00:00Z');

function habit(over: Partial<Habit> = {}): Habit {
  return {
    name: 'Floss',
    schedule: 'daily',
    time: '21:00',
    tz: NY,
    answer: 'done',
    nudge: true,
    archived: false,
    createdAt: { seconds: 0, nanoseconds: 0 },
    updatedAt: { seconds: 0, nanoseconds: 0 },
    createdBy: 'user',
    ...over,
  } as Habit;
}

function fakes(
  habits: NudgingHabit[],
  opts: {
    module?: HabitsModule;
    sent?: Record<string, string>;
    logged?: Record<string, HabitEntry>;
    devices?: Device[];
  } = {},
) {
  const marks: Record<string, Record<string, string>> = { u1: { ...opts.sent } };
  const store = {
    nudging: vi.fn(async () => habits),
    module: vi.fn(async () => opts.module ?? { on: true, config: habitsConfig({}) }),
    sent: vi.fn(async (uid: string) => ({ ...marks[uid] })),
    claim: vi.fn<NudgeStore['claim']>(async (uid, id, day, stillDue) => {
      const h = habits.find((x) => x.uid === uid && x.id === id);
      const ok = stillDue({
        habit: h?.habit,
        changedAt: h?.changedAt,
        logged: opts.logged?.[`${id}/${day}`],
        sentFor: marks[uid]?.[id],
      });
      if (ok) (marks[uid] ??= {})[id] = day;
      return ok;
    }),
    devices: vi.fn(async () => opts.devices ?? [{ id: 'd1', token: 't1' }]),
    removeDevice: vi.fn(async () => undefined),
  } satisfies NudgeStore;
  const sender = {
    send: vi.fn(async (tokens: string[]) =>
      tokens.map((t): SendResult => (t === 'dead' ? 'gone' : 'sent')),
    ),
  };
  return { store, sender, marks };
}

describe('sendNudges (step 4 of #324)', () => {
  it('pushes a due nudge once, naming the habit, and opens Right Now', async () => {
    const { store, sender, marks } = fakes([{ uid: 'u1', id: 'floss', habit: habit() }]);
    const report = await sendNudges(store, sender, AT + 30_000);
    expect(report).toEqual({ nudging: 1, pushed: 1, sent: 1, failed: 0, removedDevices: 0 });
    expect(sender.send).toHaveBeenCalledWith(['t1'], {
      tag: 'habit-floss',
      title: 'Floss',
      body: 'Right Now · not logged yet today',
      url: '/right-now',
    });
    expect(marks['u1']).toEqual({ floss: '2026-11-21' });
    // A rerun, or the wake after the hourly run: nothing twice.
    const again = await sendNudges(store, sender, AT + 60_000);
    expect(again.pushed).toBe(0);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('sends nothing before the time, for a logged day, or with Habits off', async () => {
    const h = { uid: 'u1', id: 'floss', habit: habit() };
    const early = fakes([h]);
    expect((await sendNudges(early.store, early.sender, AT - 1)).pushed).toBe(0);
    expect(early.store.claim).not.toHaveBeenCalled();

    const logged = fakes([h], {
      logged: { 'floss/2026-11-21': { state: 'skipped', at: { seconds: 1, nanoseconds: 0 } } },
    });
    expect((await sendNudges(logged.store, logged.sender, AT)).pushed).toBe(0);
    expect(logged.marks['u1']).toEqual({});

    const off = fakes([h], { module: { on: false, config: habitsConfig({}) } });
    expect((await sendNudges(off.store, off.sender, AT)).pushed).toBe(0);
    expect(off.store.claim).not.toHaveBeenCalled();
    expect(off.sender.send).not.toHaveBeenCalled();
  });

  it('claims with no device, and drops a token FCM calls gone', async () => {
    const none = fakes([{ uid: 'u1', id: 'floss', habit: habit() }], { devices: [] });
    expect(await sendNudges(none.store, none.sender, AT)).toMatchObject({ pushed: 1, sent: 0 });
    expect(none.sender.send).not.toHaveBeenCalled();

    const gone = fakes(
      [
        { uid: 'u1', id: 'floss', habit: habit() },
        { uid: 'u1', id: 'tea', habit: habit({ name: 'Tea' }) },
      ],
      {
        devices: [
          { id: 'd1', token: 't1' },
          { id: 'd2', token: 'dead' },
        ],
      },
    );
    const report = await sendNudges(gone.store, gone.sender, AT);
    expect(report.removedDevices).toBe(1);
    expect(gone.store.removeDevice).toHaveBeenCalledWith('u1', 'd2');
    // The second habit's push skips the device just removed.
    expect(gone.sender.send.mock.calls[1][0]).toEqual(['t1']);
  });

  it('reads each gardener’s module and marks once a run', async () => {
    const { store, sender } = fakes([
      { uid: 'u1', id: 'a', habit: habit({ time: '08:00' }) },
      { uid: 'u1', id: 'b', habit: habit({ time: '09:00' }) },
    ]);
    await sendNudges(store, sender, AT);
    expect(store.module).toHaveBeenCalledTimes(1);
    expect(store.sent).toHaveBeenCalledTimes(1);
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('words the push with the name only', () => {
    expect(nudgeMessage('h1', 'Drink metamucil')).toEqual({
      tag: 'habit-h1',
      title: 'Drink metamucil',
      body: 'Right Now · not logged yet today',
      url: '/right-now',
    });
  });
});

describe('waking for nudges', () => {
  const queue = () => ({ enqueue: vi.fn<WakeQueue['enqueue']>(async () => undefined) });
  const config = habitsConfig({});

  it('queues a wake at the next nudge, named by habit and time', async () => {
    const q = queue();
    const h = { uid: 'u1', id: 'floss', habit: habit() };
    expect(await wakeForNudge(q, h, config, AT - 3_600_000)).toBe(true);
    expect(q.enqueue).toHaveBeenCalledWith('u1', 'floss', AT, nudgeWakeName('u1', 'floss', AT));
    expect(await wakeForNudge(q, { ...h, habit: habit({ nudge: false }) }, config, AT)).toBe(false);
  });

  it('queues the next hour’s nudges only, and none with Habits off', async () => {
    const q = queue();
    const habits = [
      { uid: 'u1', id: 'soon', habit: habit() },
      { uid: 'u1', id: 'later', habit: habit({ time: '07:00' }) },
    ];
    const store = {
      nudging: vi.fn(async () => habits),
      module: vi.fn(async () => ({ on: true, config })),
    };
    expect(await wakeUpcomingNudges(store, q, AT - 30 * 60_000)).toBe(1);
    expect(q.enqueue.mock.calls[0][1]).toBe('soon');
    const off = { ...store, module: vi.fn(async () => ({ on: false, config })) };
    expect(await wakeUpcomingNudges(off, queue(), AT - 30 * 60_000)).toBe(0);
  });
});
