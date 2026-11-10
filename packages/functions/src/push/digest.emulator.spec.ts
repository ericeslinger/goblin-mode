import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sendDigests } from './digest';
import { digestStatePath, firestoreDigestStore } from './digest-store';
import type { PushMessage, PushSender } from './send-due';

// Runs inside `npm run e2e`, against the e2e Firestore emulator, under
// its own project id so it never touches journey or rules-test data.
const PROJECT = 'demo-mossgoblin-digest';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'digest-spec');
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

// 2026-11-09 08:10 in New York (13:10 UTC); yesterday there ran from
// 2026-11-08 05:00 UTC to 2026-11-09 05:00 UTC.
const NOW = Date.parse('2026-11-09T13:10:00Z');
const YESTERDAY = Date.parse('2026-11-08T18:00:00Z');
const TODAY = Date.parse('2026-11-09T12:00:00Z');
const TZ = 'America/New_York';

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
  digest: object | undefined,
  opts: {
    devices?: string[];
    records?: { at: number; tool: string; summary: string; notes: object[] }[];
  } = {},
) {
  await db.doc(`users/${uid}/settings/assistant`).set({
    gardenOnArrival: false,
    ...(digest ? { digest } : {}),
    updatedAt: Timestamp.fromMillis(NOW),
  });
  for (const [i, token] of (opts.devices ?? ['tok']).entries()) {
    await db.doc(`users/${uid}/devices/d${i}`).set({ token, updatedAt: Timestamp.fromMillis(NOW) });
  }
  for (const [i, r] of (opts.records ?? []).entries()) {
    await db.doc(`users/${uid}/activity/r${i}`).set({
      ...r,
      at: Timestamp.fromMillis(r.at),
      reminders: [],
      agent: 'Claude',
    });
  }
}

const made = (at: number, id: string, title: string) => ({
  at,
  tool: 'create_note',
  summary: 'Wrote a new note',
  notes: [{ id, title, made: true }],
});

describe('sendDigests over Firestore', () => {
  it("pushes yesterday's line once at the chosen hour, and not again", async () => {
    await gardener(
      'a',
      { push: true, hour: 8, timeZone: TZ },
      {
        devices: ['tok', 'dead'],
        records: [
          made(YESTERDAY, 'g', 'Gift ideas'),
          {
            at: YESTERDAY + 1000,
            tool: 'link_notes',
            summary: 'Linked a note to 1 other',
            notes: [
              { id: 'k', title: 'Glaze test' },
              { id: 'p', title: 'Pottery' },
            ],
          },
          // Today's is not yesterday's.
          made(TODAY, 't', 'Today’s note'),
        ],
      },
    );
    await db
      .doc('users/a/notes/p')
      .set({ kind: 'concept', conceptType: 'project', title: 'Pottery' });
    const { sent, send } = sender();
    const store = firestoreDigestStore(db);

    const first = await sendDigests(store, send, NOW);
    expect(first).toMatchObject({ due: 1, pushed: 1, sent: 1, failed: 1, removedDevices: 1 });
    expect(sent).toEqual([
      {
        tokens: ['tok', 'dead'],
        message: {
          tag: 'digest',
          title: 'What assistants changed',
          body: 'Yesterday: 1 note filed under Pottery, Gift ideas made.',
          url: '/activity',
        },
      },
    ]);
    expect((await db.doc(digestStatePath('a')).get()).get('sentFor')).toBe('2026-11-09');
    expect((await db.collection('users/a/devices').get()).docs.map((d) => d.id)).toEqual(['d0']);

    const again = await sendDigests(store, send, NOW + 20 * 60_000);
    expect(again).toMatchObject({ due: 1, pushed: 0, already: 1 });
    expect(sent).toHaveLength(1);
  });

  it('sends nothing when yesterday had no changes, and claims nothing', async () => {
    await gardener(
      'a',
      { push: true, hour: 8, timeZone: TZ },
      { records: [made(TODAY, 't', 'Today')] },
    );
    const { sent, send } = sender();
    const report = await sendDigests(firestoreDigestStore(db), send, NOW);
    expect(report).toMatchObject({ due: 1, empty: 1, pushed: 0 });
    expect(sent).toEqual([]);
    expect((await db.doc(digestStatePath('a')).get()).exists).toBe(false);
  });

  it('respects the switch and the hour, and reads a missing zone as UTC', async () => {
    const records = [made(YESTERDAY, 'g', 'Gift ideas')];
    await gardener('off', { push: false, hour: 8, timeZone: TZ }, { records });
    await gardener('never', undefined, { records });
    await gardener('later', { push: true, hour: 9, timeZone: TZ }, { records });
    // 13:10 UTC: hour 13 with no zone stored.
    await gardener('utc', { push: true, hour: 13 }, { records });
    const { sent, send } = sender();
    const report = await sendDigests(firestoreDigestStore(db), send, NOW);
    expect(report).toMatchObject({ due: 1, pushed: 1 });
    expect(sent.map((s) => s.message.body)).toEqual(['Yesterday: Gift ideas made.']);
    expect((await db.doc(digestStatePath('utc')).get()).get('sentFor')).toBe('2026-11-09');
    for (const uid of ['off', 'never', 'later'])
      expect((await db.doc(digestStatePath(uid)).get()).exists).toBe(false);
  });

  it('claims the day even with no device, so a device added later gets no stale digest', async () => {
    await gardener(
      'a',
      { push: true, hour: 8, timeZone: TZ },
      { devices: [], records: [made(YESTERDAY, 'g', 'Gift ideas')] },
    );
    const { sent, send } = sender();
    const report = await sendDigests(firestoreDigestStore(db), send, NOW);
    expect(report).toMatchObject({ due: 1, pushed: 1, sent: 0 });
    expect(sent).toEqual([]);
  });
});
