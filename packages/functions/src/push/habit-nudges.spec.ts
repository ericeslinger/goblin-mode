import { type Habit, type HabitEntry, addDays, habitsConfig } from '@mossgoblin/schema';
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
    /** The habit as the claim reads it again, where it changed since the query. */
    fresh?: Record<string, Habit>;
    devices?: Device[];
  } = {},
) {
  const marks: Record<string, Record<string, string>> = { u1: { ...opts.sent } };
  const store = {
    nudging: vi.fn(async () => habits),
    module: vi.fn(async () => opts.module ?? { on: true, config: habitsConfig({}) }),
    sent: vi.fn(async (uid: string) => ({ ...marks[uid] })),
    claim: vi.fn<NudgeStore['claim']>(async (uid, id, day, period, stillDue) => {
      const h = habits.find((x) => x.uid === uid && x.id === id);
      // The period's check-ins, as the store reads them from its months.
      const entries = new Map<string, HabitEntry>();
      for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
        const e = opts.logged?.[`${id}/${d}`];
        if (e) entries.set(d, e);
      }
      const ok = stillDue({
        habit: opts.fresh?.[id] ?? h?.habit,
        changedAt: h?.changedAt,
        entries,
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
    expect(nudgeMessage('h1', 'Shop', 'weekly').body).toBe('Right Now · not done yet this week');
    expect(nudgeMessage('h1', 'Rent', 'monthly').body).toBe('Right Now · not done yet this month');
  });

  it('sends a time in the quiet hours before midnight at their start (Eric, 2026-11-22)', async () => {
    const ten = AT + 60 * 60_000; // 22:00 in New York
    const { store, sender, marks } = fakes([
      { uid: 'u1', id: 'tea', habit: habit({ time: '22:45' }) },
    ]);
    expect((await sendNudges(store, sender, ten - 60_000)).pushed).toBe(0);
    expect((await sendNudges(store, sender, ten + 20 * 60_000)).pushed).toBe(1);
    expect(marks['u1']).toEqual({ tea: '2026-11-21' });
  });
});

describe('weekly and monthly nudges (Eric, 2026-11-22)', () => {
  /** 21:00 in New York on Sunday 2026-11-22, the last day of a week from Monday. */
  const SUN = Date.parse('2026-11-23T02:00:00Z');
  const done: HabitEntry = { state: 'done', at: { seconds: 1, nanoseconds: 0 } };

  it('pushes a weekly habit once on the last day of its week, saying the week', async () => {
    const h = { uid: 'u1', id: 'shop', habit: habit({ name: 'Shop', schedule: 'weekly' }) };
    const { store, sender, marks } = fakes([h]);
    expect((await sendNudges(store, sender, AT)).pushed).toBe(0); // Saturday
    expect((await sendNudges(store, sender, SUN)).pushed).toBe(1);
    expect(store.claim.mock.calls[0].slice(2, 4)).toEqual([
      '2026-11-22',
      { start: '2026-11-16', end: '2026-11-22' },
    ]);
    expect(sender.send).toHaveBeenCalledWith(
      ['t1'],
      expect.objectContaining({ body: 'Right Now · not done yet this week' }),
    );
    expect(marks['u1']).toEqual({ shop: '2026-11-22' });
    expect((await sendNudges(store, sender, SUN + 60_000)).pushed).toBe(0);
  });

  it('sends none for a week settled earlier, a week across two months read whole', async () => {
    const h = { uid: 'u1', id: 'shop', habit: habit({ schedule: 'weekly' }) };
    const dec6 = Date.parse('2026-12-07T02:00:00Z'); // Sunday 2026-12-06, 21:00 EST
    const settled = fakes([h], { logged: { 'shop/2026-11-30': done } });
    expect((await sendNudges(settled.store, settled.sender, dec6)).pushed).toBe(0);
    expect(settled.store.claim.mock.calls[0][3]).toEqual({
      start: '2026-11-30',
      end: '2026-12-06',
    });
    expect(settled.marks['u1']).toEqual({});
  });

  it('sends none on the 30th for a month already nudged as a weekly habit', async () => {
    const h = { uid: 'u1', id: 'rent', habit: habit({ schedule: 'monthly' }) };
    const end = Date.parse('2026-12-01T02:00:00Z'); // 2026-11-30, 21:00 EST
    const nudged = fakes([h], { sent: { rent: '2026-11-22' } });
    expect((await sendNudges(nudged.store, nudged.sender, end)).pushed).toBe(0);
    const fresh = fakes([h], { sent: { rent: '2026-10-31' } });
    expect((await sendNudges(fresh.store, fresh.sender, end)).pushed).toBe(1);
  });

  it('claims nothing when the schedule changed since the query', async () => {
    const h = { uid: 'u1', id: 'shop', habit: habit({ schedule: 'weekly' }) };
    const { store, sender } = fakes([h], {
      fresh: { shop: habit({ schedule: 'monthly' }) },
    });
    expect((await sendNudges(store, sender, SUN)).pushed).toBe(0);
    expect(store.claim).toHaveBeenCalledTimes(1);
  });
});

describe('nudges for N times a week (2026-11-23)', () => {
  const done: HabitEntry = { state: 'done', at: { seconds: 1, nanoseconds: 0 } };
  /** 21:00 in New York, Friday 20 to Sunday 22 November 2026. */
  const FRI = Date.parse('2026-11-21T02:00:00Z');
  const SAT = Date.parse('2026-11-22T02:00:00Z');
  const SUN = Date.parse('2026-11-23T02:00:00Z');
  const write = () => ({
    uid: 'u1',
    id: 'write',
    habit: habit({ name: 'Write', schedule: 'weekly', times: 3 }),
  });

  it('nudges each of the last three days with none done, once a day, saying the count', async () => {
    const { store, sender, marks } = fakes([write()]);
    expect((await sendNudges(store, sender, FRI - 86_400_000)).pushed).toBe(0); // Thursday
    expect((await sendNudges(store, sender, FRI)).pushed).toBe(1);
    expect(marks['u1']).toEqual({ write: '2026-11-20' });
    // A rerun, an overlapping run or a duplicate wake the same day: none.
    expect((await sendNudges(store, sender, FRI + 60_000)).pushed).toBe(0);
    expect((await sendNudges(store, sender, SAT)).pushed).toBe(1);
    expect((await sendNudges(store, sender, SUN)).pushed).toBe(1);
    expect(marks['u1']).toEqual({ write: '2026-11-22' });
    expect(sender.send).toHaveBeenCalledTimes(3);
    expect(sender.send).toHaveBeenLastCalledWith(
      ['t1'],
      expect.objectContaining({ body: 'Right Now · 0 of 3 this week' }),
    );
  });

  it('with two done by Friday, only on the last day; once met, none', async () => {
    const two = { 'write/2026-11-17': done, 'write/2026-11-19': done };
    const { store, sender } = fakes([write()], { logged: two });
    expect((await sendNudges(store, sender, FRI)).pushed).toBe(0);
    expect((await sendNudges(store, sender, SAT)).pushed).toBe(0);
    expect((await sendNudges(store, sender, SUN)).pushed).toBe(1);
    expect(sender.send).toHaveBeenCalledWith(
      ['t1'],
      expect.objectContaining({ body: 'Right Now · 2 of 3 this week' }),
    );
    const met = fakes([write()], { logged: { ...two, 'write/2026-11-21': done } });
    expect((await sendNudges(met.store, met.sender, SUN)).pushed).toBe(0);
  });

  it('sends none on a day already ticked', async () => {
    const { store, sender } = fakes([write()], { logged: { 'write/2026-11-20': done } });
    expect((await sendNudges(store, sender, FRI)).pushed).toBe(0);
  });

  it('words the push with the week’s count', () => {
    expect(nudgeMessage('w', 'Write', 'weekly', { done: 1, target: 3 }).body).toBe(
      'Right Now · 1 of 3 this week',
    );
    expect(nudgeMessage('w', 'Shop', 'weekly', { done: 0, target: 1 }).body).toBe(
      'Right Now · not done yet this week',
    );
  });
});

describe('nudges for a weekly habit on its own weekday (2026-11-25)', () => {
  const done: HabitEntry = { state: 'done', at: { seconds: 1, nanoseconds: 0 } };
  /** 19:00 in New York on Wednesday 25 and Sunday 29 November 2026. */
  const WED = Date.parse('2026-11-26T00:00:00Z');
  const SUN = Date.parse('2026-11-30T00:00:00Z');
  const garbage = () => ({
    uid: 'u1',
    id: 'garbage',
    habit: habit({
      name: 'Take out the garbage',
      schedule: 'weekly',
      weekday: 'Wed',
      time: '19:00',
    }),
  });

  it('nudges on its weekday, not the week’s last day, once, saying today', async () => {
    const { store, sender, marks } = fakes([garbage()]);
    expect((await sendNudges(store, sender, SUN - 7 * 86_400_000)).pushed).toBe(0);
    expect((await sendNudges(store, sender, WED)).pushed).toBe(1);
    expect(marks['u1']).toEqual({ garbage: '2026-11-25' });
    expect((await sendNudges(store, sender, WED + 60_000)).pushed).toBe(0);
    expect((await sendNudges(store, sender, SUN)).pushed).toBe(0);
    expect(sender.send).toHaveBeenCalledWith(
      ['t1'],
      expect.objectContaining({
        title: 'Take out the garbage',
        body: 'Right Now · not done yet today',
      }),
    );
  });

  it('sends none when its day is logged; another day logged does not stop it', async () => {
    const ticked = fakes([garbage()], { logged: { 'garbage/2026-11-25': done } });
    expect((await sendNudges(ticked.store, ticked.sender, WED)).pushed).toBe(0);
    const other = fakes([garbage()], { logged: { 'garbage/2026-11-24': done } });
    expect((await sendNudges(other.store, other.sender, WED)).pushed).toBe(1);
  });

  it('wakes for its weekday', async () => {
    const enqueue = vi.fn<WakeQueue['enqueue']>(async () => undefined);
    const q: WakeQueue = { enqueue };
    // Monday 23 November, 10:00 in New York.
    expect(
      await wakeForNudge(q, garbage(), habitsConfig({}), Date.parse('2026-11-23T15:00:00Z')),
    ).toBe(true);
    expect(enqueue).toHaveBeenCalledWith('u1', 'garbage', WED, expect.any(String));
  });
});

describe('nudges follow the device’s zone (Eric, 2026-11-22)', () => {
  it('reads the day and time in the module’s zone, not the habit’s', async () => {
    // Made in New York; the app last ran in Paris, where 21:00 on the
    // 21st is 20:00 UTC.
    const paris = Date.parse('2026-11-21T20:00:00Z');
    const module = { on: true, config: habitsConfig({ tz: 'Europe/Paris' }) };
    const { store, sender, marks } = fakes([{ uid: 'u1', id: 'floss', habit: habit() }], {
      module,
    });
    expect((await sendNudges(store, sender, paris)).pushed).toBe(1);
    expect(marks['u1']).toEqual({ floss: '2026-11-21' });
    // Back in New York (westward), 21:00 on the 21st again: no second push.
    const ny = fakes([{ uid: 'u1', id: 'floss', habit: habit() }], {
      sent: { floss: '2026-11-21' },
      module: { on: true, config: habitsConfig({ tz: 'America/New_York' }) },
    });
    expect((await sendNudges(ny.store, ny.sender, AT)).pushed).toBe(0);
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

  it('queues no wake beyond a task’s reach: the hourly run queues it later', async () => {
    const q = queue();
    // A monthly habit on 2026-12-02: its nudge is on the 31st, 29 days on.
    const h = { uid: 'u1', id: 'rent', habit: habit({ schedule: 'monthly' }) };
    expect(await wakeForNudge(q, h, config, Date.parse('2026-12-01T12:00:00Z'))).toBe(false);
    expect(q.enqueue).not.toHaveBeenCalled();
    // On the 30th it is a day away, and queued at its moment.
    const end = Date.parse('2027-01-01T02:00:00Z');
    expect(await wakeForNudge(q, h, config, Date.parse('2026-12-30T12:00:00Z'))).toBe(true);
    expect(q.enqueue).toHaveBeenCalledWith('u1', 'rent', end, nudgeWakeName('u1', 'rent', end));
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
