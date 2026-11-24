import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { firestoreNudgeStore, nudgeStatePath } from './habit-nudge-store';
import { sendNudges, wakeUpcomingNudges } from './habit-nudges';
import type { PushMessage, PushSender } from './send-due';
import type { WakeQueue } from './wake';

// Habit nudges over Firestore (step 4 of #324), inside `npm run e2e`,
// against the e2e Firestore emulator under its own project id, as the
// digest's spec runs.
const PROJECT = 'demo-mossgoblin-nudges';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'nudge-spec');
let db: Firestore;

beforeAll(() => {
  process.env['FIRESTORE_EMULATOR_HOST'] = HOST;
  db = getFirestore(app);
});
beforeEach(async () => {
  const res = await fetch(
    `http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`could not clear the emulator: ${res.status}`);
});
afterAll(() => deleteApp(app));

const NY = 'America/New_York';
/** 21:00 in New York on Saturday 2026-11-21. */
const AT = Date.parse('2026-11-22T02:00:00Z');
const MADE = Date.parse('2026-11-01T12:00:00Z');
const at = (ms: number) => Timestamp.fromMillis(ms);

function sender() {
  const sent: { tokens: string[]; message: PushMessage }[] = [];
  const send: PushSender = {
    async send(tokens, message) {
      sent.push({ tokens, message });
      return tokens.map((t) => (t === 'dead' ? 'gone' : 'sent'));
    },
  };
  return { sent, send };
}

async function gardener(
  uid: string,
  opts: { on?: boolean; devices?: string[]; config?: Record<string, unknown> } = {},
) {
  await db.doc(`users/${uid}/settings/modules`).set({
    habits: { enabled: opts.on ?? true, ...(opts.config ? { config: opts.config } : {}) },
    updatedAt: at(MADE),
  });
  for (const [i, token] of (opts.devices ?? ['tok']).entries()) {
    await db.doc(`users/${uid}/devices/d${i}`).set({ token, updatedAt: at(MADE) });
  }
}

/** A habit as the app makes it, its nudge on unless said. */
async function habit(uid: string, id: string, over: Record<string, unknown> = {}) {
  await db.doc(`users/${uid}/habits/${id}`).set({
    name: 'Floss',
    schedule: 'daily',
    time: '21:00',
    tz: NY,
    answer: 'done',
    nudge: true,
    archived: false,
    createdAt: at(MADE),
    updatedAt: at(MADE),
    createdBy: 'user',
    ...over,
  });
}

async function tick(uid: string, id: string, day: string, state: 'done' | 'skipped') {
  await db.doc(`users/${uid}/habitLogs/${id}_${day.slice(0, 7)}`).set(
    {
      habit: id,
      month: day.slice(0, 7),
      days: { [day.slice(8)]: { state, at: at(AT - 60_000) } },
    },
    { merge: true },
  );
}

describe('sendNudges over Firestore', () => {
  it('nudges a habit of three a week on each of the last days, one a day (2026-11-23)', async () => {
    await gardener('u1');
    await habit('u1', 'write', { name: 'Write', schedule: 'weekly', times: 3 });
    // Monday 2026-11-30 done: the week of 11-30 to 12-06 spans two months.
    await tick('u1', 'write', '2026-11-30', 'done');
    const s = sender();
    const store = firestoreNudgeStore(db);
    // 21:00 EST, Friday 4 to Sunday 6 December: two still needed, so
    // none on Friday, then Saturday and Sunday.
    const fri = Date.parse('2026-12-05T02:00:00Z');
    const day = 86_400_000;
    expect((await sendNudges(store, s.send, fri)).pushed).toBe(0);
    expect((await sendNudges(store, s.send, fri + day)).pushed).toBe(1);
    expect((await sendNudges(store, s.send, fri + day + 60_000)).pushed).toBe(0);
    expect((await sendNudges(store, s.send, fri + 2 * day)).pushed).toBe(1);
    expect(s.sent.map((x) => x.message.body)).toEqual([
      'Right Now · 1 of 3 this week',
      'Right Now · 1 of 3 this week',
    ]);
    expect((await db.doc(nudgeStatePath('u1')).get()).get('sent')).toEqual({
      write: '2026-12-06',
    });
  });

  it('pushes a due nudge once, marks the day server-side, and not again', async () => {
    await gardener('u1');
    await habit('u1', 'floss');
    await habit('u1', 'quiet', { name: 'Off', nudge: false });
    const s = sender();
    const store = firestoreNudgeStore(db);
    const report = await sendNudges(store, s.send, AT + 30_000);
    expect(report).toEqual({ nudging: 1, pushed: 1, sent: 1, failed: 0, removedDevices: 0 });
    expect(s.sent).toEqual([
      {
        tokens: ['tok'],
        message: {
          tag: 'habit-floss',
          title: 'Floss',
          body: 'Right Now · not logged yet today',
          url: '/right-now',
        },
      },
    ]);
    expect((await db.doc(nudgeStatePath('u1')).get()).get('sent')).toEqual({
      floss: '2026-11-21',
    });
    // The stored habit is as it was: the mark is not on it.
    expect((await db.doc('users/u1/habits/floss').get()).get('updatedAt')).toEqual(at(MADE));
    expect((await sendNudges(store, s.send, AT + 120_000)).pushed).toBe(0);
    expect(s.sent).toHaveLength(1);
  });

  it('sends none for a day already done or skipped, nor with Habits off', async () => {
    await gardener('u1');
    await habit('u1', 'floss');
    await habit('u1', 'run', { name: 'Run' });
    await tick('u1', 'floss', '2026-11-21', 'done');
    await tick('u1', 'run', '2026-11-21', 'skipped');
    const s = sender();
    expect((await sendNudges(firestoreNudgeStore(db), s.send, AT)).pushed).toBe(0);
    expect(s.sent).toEqual([]);
    expect((await db.doc(nudgeStatePath('u1')).get()).exists).toBe(false);

    await gardener('u2', { on: false });
    await habit('u2', 'tea');
    expect((await sendNudges(firestoreNudgeStore(db), s.send, AT)).pushed).toBe(0);
  });

  it('holds a nudge in the quiet hours to their end, read from the module', async () => {
    await db.doc('users/u1/settings/modules').set({
      habits: { enabled: true, config: { quietFrom: '20:00', quietTo: '23:00' } },
      updatedAt: at(MADE),
    });
    await db.doc('users/u1/devices/d0').set({ token: 'tok', updatedAt: at(MADE) });
    await habit('u1', 'floss');
    const s = sender();
    expect((await sendNudges(firestoreNudgeStore(db), s.send, AT)).pushed).toBe(0);
    // 23:00 in New York.
    const end = Date.parse('2026-11-22T04:00:00Z');
    expect((await sendNudges(firestoreNudgeStore(db), s.send, end)).pushed).toBe(1);
  });

  it('drops a token FCM calls gone, and passes over a habit that does not parse', async () => {
    await gardener('u1', { devices: ['tok', 'dead'] });
    await habit('u1', 'floss');
    await habit('u1', 'bad', { time: 'nine' });
    const s = sender();
    const report = await sendNudges(firestoreNudgeStore(db), s.send, AT);
    expect(report).toMatchObject({ nudging: 1, pushed: 1, sent: 1, failed: 1, removedDevices: 1 });
    expect((await db.collection('users/u1/devices').get()).docs.map((d) => d.id)).toEqual(['d0']);
  });

  it('queues a wake for each nudge in the next hour', async () => {
    await gardener('u1');
    await habit('u1', 'floss');
    await habit('u1', 'pills', { name: 'Pills', time: '11:00' });
    const queued: string[] = [];
    const queue: WakeQueue = {
      async enqueue(_uid, id) {
        queued.push(id);
      },
    };
    expect(await wakeUpcomingNudges(firestoreNudgeStore(db), queue, AT - 20 * 60_000)).toBe(1);
    expect(queued).toEqual(['floss']);
  });

  it('sends a 22:30 habit at 22:00, as the quiet hours begin (Eric, 2026-11-22)', async () => {
    await gardener('u1');
    await habit('u1', 'tea', { name: 'Tea', time: '22:30' });
    const s = sender();
    const ten = AT + 60 * 60_000; // 22:00 in New York
    expect((await sendNudges(firestoreNudgeStore(db), s.send, ten - 60_000)).pushed).toBe(0);
    expect((await sendNudges(firestoreNudgeStore(db), s.send, ten)).pushed).toBe(1);
    expect((await db.doc(nudgeStatePath('u1')).get()).get('sent')).toEqual({
      tea: '2026-11-21',
    });
  });
});

describe('weekly and monthly nudges over Firestore (Eric, 2026-11-22)', () => {
  /** 21:00 in New York on Sunday 2026-12-06, ending a week that began in November. */
  const DEC6 = Date.parse('2026-12-07T02:00:00Z');

  it('reads both months of a week across a month’s start in the claim', async () => {
    await gardener('u1');
    await habit('u1', 'shop', { name: 'Shop', schedule: 'weekly' });
    await habit('u1', 'pots', { name: 'Pots', schedule: 'weekly' });
    await tick('u1', 'shop', '2026-11-30', 'done');
    const s = sender();
    const report = await sendNudges(firestoreNudgeStore(db), s.send, DEC6);
    expect(report.pushed).toBe(1);
    expect(s.sent.map((x) => x.message)).toEqual([
      {
        tag: 'habit-pots',
        title: 'Pots',
        body: 'Right Now · not done yet this week',
        url: '/right-now',
      },
    ]);
    expect((await db.doc(nudgeStatePath('u1')).get()).get('sent')).toEqual({
      pots: '2026-12-06',
    });
  });

  it('nudges a monthly habit on the month’s last day only, once', async () => {
    await gardener('u1');
    await habit('u1', 'rent', { name: 'Rent', schedule: 'monthly' });
    const s = sender();
    const store = firestoreNudgeStore(db);
    expect((await sendNudges(store, s.send, AT)).pushed).toBe(0);
    const end = Date.parse('2026-12-01T02:00:00Z'); // 2026-11-30, 21:00 EST
    expect((await sendNudges(store, s.send, end)).pushed).toBe(1);
    expect((await sendNudges(store, s.send, end + 60_000)).pushed).toBe(0);
    expect(s.sent[0].message.body).toBe('Right Now · not done yet this month');
  });
});

describe('nudges follow the device’s zone over Firestore (Eric, 2026-11-22)', () => {
  it('reads the day and time in the module’s zone', async () => {
    await gardener('u1', { config: { tz: 'Asia/Tokyo' } });
    await habit('u1', 'floss');
    const s = sender();
    const store = firestoreNudgeStore(db);
    // 21:00 in New York is 11:00 the next morning in Tokyo: nothing.
    expect((await sendNudges(store, s.send, AT)).pushed).toBe(0);
    // 21:00 in Tokyo on the 22nd is 12:00 UTC.
    const tokyo = Date.parse('2026-11-22T12:00:00Z');
    expect((await sendNudges(store, s.send, tokyo)).pushed).toBe(1);
    expect((await db.doc(nudgeStatePath('u1')).get()).get('sent')).toEqual({
      floss: '2026-11-22',
    });
  });
});
