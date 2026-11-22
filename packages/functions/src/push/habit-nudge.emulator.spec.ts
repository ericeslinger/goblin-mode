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

async function gardener(uid: string, opts: { on?: boolean; devices?: string[] } = {}) {
  await db.doc(`users/${uid}/settings/modules`).set({
    habits: { enabled: opts.on ?? true },
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
});
