// The core of sendDuePush, over a small store and sender interface so it
// runs in unit specs without Firestore or FCM (see firestore-store.ts
// for the real store and send-due-push.ts for the wiring).
import { type Recurrence, type ReminderStatus, nextPushAfter } from '@goblin/schema';

/** A reminder whose push time has come; times in milliseconds. */
export interface DueReminder {
  uid: string;
  id: string;
  text: string;
  status: ReminderStatus;
  dueAt?: number;
  snoozedUntil?: number;
  nextFireAt: number;
  recurrence?: Recurrence;
  noteId?: string;
}

export interface Device {
  id: string;
  token: string;
}

export interface PushStore {
  /** Reminders with `nextFireAt <= now`, oldest first, at most `limit`. */
  due(now: number, limit: number): Promise<DueReminder[]>;
  /**
   * Moves `nextFireAt` on (or removes it) only if it still equals
   * `expected`, so a reminder done or snoozed meanwhile is left alone and
   * two overlapping runs never both claim it. True when claimed.
   */
  claim(r: DueReminder, expected: number, next: number | undefined): Promise<boolean>;
  devices(uid: string): Promise<Device[]>;
  removeDevice(uid: string, deviceId: string): Promise<void>;
}

/** Per token: sent, a token FCM says is gone, or some other failure. */
export type SendResult = 'sent' | 'gone' | 'failed';

export interface PushSender {
  send(tokens: string[], message: PushMessage): Promise<SendResult[]>;
}

/** What a notification shows and where a tap goes (an app path). */
export interface PushMessage {
  tag: string;
  title: string;
  body: string;
  url: string;
}

/** At most this many reminders per run; the rest go next minute. */
export const BATCH = 100;

export function messageFor(r: DueReminder): PushMessage {
  return {
    tag: r.id,
    title: r.text,
    body: r.recurrence ? 'Right Now · repeats' : 'Right Now',
    url: r.noteId ? `/?note=${encodeURIComponent(r.noteId)}` : '/right-now',
  };
}

export interface RunReport {
  claimed: number;
  sent: number;
  failed: number;
  removedDevices: number;
}

/**
 * One run: claim each due reminder (moving `nextFireAt` to the next
 * repeat, or removing it), then push it to every device of its owner.
 * Claim first, then send: a failed send loses one nudge, but a crash
 * can never push the same reminder twice. Tokens FCM reports gone are
 * removed.
 */
export async function sendDue(
  store: PushStore,
  sender: PushSender,
  now: number,
): Promise<RunReport> {
  const report: RunReport = { claimed: 0, sent: 0, failed: 0, removedDevices: 0 };
  const devices = new Map<string, Promise<Device[]>>();
  for (const r of await store.due(now, BATCH)) {
    if (!(await store.claim(r, r.nextFireAt, nextPushAfter(r, now)))) continue;
    report.claimed++;
    if (!devices.has(r.uid)) devices.set(r.uid, store.devices(r.uid));
    const targets = await devices.get(r.uid)!;
    if (targets.length === 0) continue;
    const results = await sender.send(
      targets.map((d) => d.token),
      messageFor(r),
    );
    for (const [i, result] of results.entries()) {
      if (result === 'sent') report.sent++;
      else report.failed++;
      if (result === 'gone') {
        await store.removeDevice(r.uid, targets[i].id);
        report.removedDevices++;
      }
    }
    // Later reminders of the same owner skip the devices just removed.
    devices.set(r.uid, Promise.resolve(targets.filter((_, i) => results[i] !== 'gone')));
  }
  return report;
}
