// Habit nudges (step 4 of #324, 2026-11-21; DESIGN.md, Habits, Nudges):
// one push at a daily habit's time, only if its day has nothing logged,
// never a second, held through the quiet hours. The core, over a small
// store, so it runs in specs without Firestore or FCM
// (habit-nudge-store.ts is the store over Firestore, habit-nudge-push.ts
// the wiring). What is due is the schema's `habitNudgeDue`; nothing here
// decides it again.
import {
  type Habit,
  type HabitEntry,
  type HabitsConfig,
  habitNextNudge,
  habitNudgeDue,
} from '@mossgoblin/schema';
import type { Device, PushMessage, PushSender, PushStore } from './send-due';
import { UPCOMING_MS, type WakeQueue, wakeAt } from './wake';

/** A habit with its nudge on, as the store finds it. */
export interface NudgingHabit {
  uid: string;
  id: string;
  habit: Habit;
  /** Its `updatedAt`: a nudge is for a moment after it. */
  changedAt?: number;
}

/** The Habits module as a gardener has it. */
export interface HabitsModule {
  on: boolean;
  config: HabitsConfig;
}

export interface NudgeStore extends Pick<PushStore, 'devices' | 'removeDevice'> {
  /** Every habit whose `nudge` is on, every gardener's. */
  nudging(): Promise<NudgingHabit[]>;
  /** The Habits module's switch and configuration. */
  module(uid: string): Promise<HabitsModule>;
  /** The last day a nudge was sent for each habit, by habit id. */
  sent(uid: string): Promise<Record<string, string>>;
  /**
   * In one transaction: reads the habit, its day's entry and the sent
   * marks again, and, when `stillDue` says the nudge is still due on
   * them, marks `day` sent for the habit. True when this run claimed
   * it, so two runs never both send it.
   */
  claim(
    uid: string,
    id: string,
    day: string,
    stillDue: (now: {
      habit?: Habit;
      changedAt?: number;
      logged?: HabitEntry;
      sentFor?: string;
    }) => boolean,
  ): Promise<boolean>;
}

/** The push for a habit's nudge: its name, and a tap opens Right Now. */
export function nudgeMessage(id: string, name: string): PushMessage {
  return {
    // One per habit: a later one replaces it.
    tag: `habit-${id}`,
    title: name,
    body: 'Right Now · not logged yet today',
    url: '/right-now',
  };
}

export interface NudgeReport {
  /** Habits with the nudge on. */
  nudging: number;
  /** Nudges claimed and pushed (to however many devices). */
  pushed: number;
  sent: number;
  failed: number;
  removedDevices: number;
}

/**
 * One run: every habit with its nudge on is read (one query), with each
 * of their gardeners' module switch and sent marks (two documents
 * each); only for a nudge whose moment has come is the day's entry
 * read, in the claim. No log is read for any other. Claim first, then send, as
 * reminders do: a failed send loses one nudge, a rerun never sends it
 * twice. Tokens FCM reports gone are removed.
 */
export async function sendNudges(
  store: NudgeStore,
  sender: PushSender,
  now: number,
): Promise<NudgeReport> {
  const habits = await store.nudging();
  const report: NudgeReport = {
    nudging: habits.length,
    pushed: 0,
    sent: 0,
    failed: 0,
    removedDevices: 0,
  };
  const modules = new Map<string, Promise<HabitsModule>>();
  const sentMarks = new Map<string, Promise<Record<string, string>>>();
  const devices = new Map<string, Promise<Device[]>>();
  for (const h of habits) {
    // Two reads per gardener with a nudging habit, once a run.
    if (!modules.has(h.uid)) {
      modules.set(h.uid, store.module(h.uid));
      sentMarks.set(h.uid, store.sent(h.uid));
    }
    const module = await modules.get(h.uid)!;
    const marks = await sentMarks.get(h.uid)!;
    const due = habitNudgeDue(h.habit, now, {
      on: module.on,
      config: module.config,
      sentFor: marks[h.id],
      changedAt: h.changedAt,
    });
    if (!due) continue;
    const claimed = await store.claim(h.uid, h.id, due.day, (fresh) => {
      if (!fresh.habit) return false;
      const again = habitNudgeDue(fresh.habit, now, {
        on: module.on,
        config: module.config,
        sentFor: fresh.sentFor,
        changedAt: fresh.changedAt,
        logged: fresh.logged,
      });
      return again?.day === due.day;
    });
    if (!claimed) continue;
    report.pushed++;
    if (!devices.has(h.uid)) devices.set(h.uid, store.devices(h.uid));
    const targets = await devices.get(h.uid)!;
    if (!targets.length) continue;
    const results = await sender.send(
      targets.map((d) => d.token),
      nudgeMessage(h.id, h.habit.name),
    );
    for (const [i, result] of results.entries()) {
      if (result === 'sent') report.sent++;
      else report.failed++;
      if (result === 'gone') {
        await store.removeDevice(h.uid, targets[i].id);
        report.removedDevices++;
      }
    }
    // Later nudges of the same gardener skip the devices just removed.
    devices.set(h.uid, Promise.resolve(targets.filter((_, i) => results[i] !== 'gone')));
  }
  return report;
}

/** A task name per habit and nudge time: the same nudge queues once. */
export function nudgeWakeName(uid: string, id: string, at: number): string {
  return `nudge-${uid}-${id}-${at}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Queues a wake for a habit's next nudge (`habitNextNudge`), when it
 * has one; named by habit and time, so one already queued is dropped.
 * `within` limits it to nudges that soon (the hourly run's next hour).
 */
export async function wakeForNudge(
  queue: WakeQueue,
  h: Pick<NudgingHabit, 'uid' | 'id' | 'habit'>,
  config: HabitsConfig,
  now: number,
  within?: number,
): Promise<boolean> {
  const next = habitNextNudge(h.habit, now, config);
  if (next === undefined || (within !== undefined && next > now + within)) return false;
  await queue.enqueue(h.uid, h.id, wakeAt(next, now), nudgeWakeName(h.uid, h.id, next));
  return true;
}

/**
 * The hourly run's second half: a wake for every nudge in the next
 * hour and a bit (`UPCOMING_MS`), so one a write did not queue (the
 * module switched on, the quiet hours changed, a lost task) still goes
 * on time. Reads each gardener's module once.
 */
export async function wakeUpcomingNudges(
  store: Pick<NudgeStore, 'nudging' | 'module'>,
  queue: WakeQueue,
  now: number,
  habits?: NudgingHabit[],
): Promise<number> {
  const modules = new Map<string, Promise<HabitsModule>>();
  let queued = 0;
  for (const h of habits ?? (await store.nudging())) {
    if (!modules.has(h.uid)) modules.set(h.uid, store.module(h.uid));
    const module = await modules.get(h.uid)!;
    if (!module.on) continue;
    if (await wakeForNudge(queue, h, module.config, now, UPCOMING_MS)) queued++;
  }
  return queued;
}
