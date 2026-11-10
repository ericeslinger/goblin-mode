// The daily digest by push (#237, step 4 of #154): at the hour each
// gardener picked, yesterday's line from What assistants changed, sent
// through the reminders' push path. The core, over a small store, so
// it runs in specs without the scheduler (digest-push.ts wires it;
// digest-store.ts is the store over Firestore). No model call.
import { type DigestRecord, digestSentence, yesterdayIn, zonedHour } from '@mossgoblin/schema';
import type { Device, PushMessage, PushSender, PushStore } from './send-due';

/** A gardener with the digest push on, as `settings/assistant` keeps it. */
export interface DigestSubscriber {
  uid: string;
  hour: number;
  timeZone?: string;
}

export interface DigestStore extends Pick<PushStore, 'devices' | 'removeDevice'> {
  /** Every gardener whose `digest.push` is on. */
  subscribers(): Promise<DigestSubscriber[]>;
  /** The gardener's records with `from <= at < to`. */
  records(uid: string, from: number, to: number): Promise<DigestRecord[]>;
  /** Which of these notes are projects, as they are now. */
  projects(uid: string, ids: string[]): Promise<Set<string>>;
  /**
   * Marks the digest of local day `day` sent, unless it already was:
   * true when this run claimed it, so two runs never both send it.
   */
  claim(uid: string, day: string): Promise<boolean>;
}

export interface DigestReport {
  /** Gardeners whose hour it was. */
  due: number;
  /** Digests claimed and pushed (to however many devices). */
  pushed: number;
  /** Yesterday had nothing to say. */
  empty: number;
  /** Already sent today. */
  already: number;
  sent: number;
  failed: number;
  removedDevices: number;
}

/** The zone to read a gardener's clock in: theirs if it is a zone, else UTC. */
export function zoneOf(timeZone: string | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

export function digestMessage(sentence: string): PushMessage {
  return { tag: 'digest', title: 'What assistants changed', body: sentence, url: '/activity' };
}

/**
 * One run, hourly: for each gardener with the switch on whose local
 * hour is the one they picked, yesterday's sentence (their day, in
 * their zone), claimed for today and then pushed to their devices.
 * Nothing is claimed or sent when yesterday had no changes. Claim
 * first, then send, as reminders do: a failed send loses one digest,
 * a rerun never sends it twice.
 */
export async function sendDigests(
  store: DigestStore,
  sender: PushSender,
  now: number,
): Promise<DigestReport> {
  const report: DigestReport = {
    due: 0,
    pushed: 0,
    empty: 0,
    already: 0,
    sent: 0,
    failed: 0,
    removedDevices: 0,
  };
  for (const sub of await store.subscribers()) {
    const tz = zoneOf(sub.timeZone);
    if (zonedHour(now, tz) !== sub.hour) continue;
    report.due++;
    const day = yesterdayIn(now, tz);
    const records = await store.records(sub.uid, day.from, day.to);
    const linked = [
      ...new Set(
        records
          .filter((r) => r.tool === 'link_notes')
          .flatMap((r) => r.notes.slice(1).map((n) => n.id)),
      ),
    ];
    const projects = linked.length ? await store.projects(sub.uid, linked) : new Set<string>();
    const sentence = digestSentence(records, { ...day, isProject: (id) => projects.has(id) });
    if (!sentence) {
      report.empty++;
      continue;
    }
    if (!(await store.claim(sub.uid, day.today))) {
      report.already++;
      continue;
    }
    report.pushed++;
    const targets: Device[] = await store.devices(sub.uid);
    if (!targets.length) continue;
    const results = await sender.send(
      targets.map((d) => d.token),
      digestMessage(sentence),
    );
    for (const [i, result] of results.entries()) {
      if (result === 'sent') report.sent++;
      else report.failed++;
      if (result === 'gone') {
        await store.removeDevice(sub.uid, targets[i].id);
        report.removedDevices++;
      }
    }
  }
  return report;
}
