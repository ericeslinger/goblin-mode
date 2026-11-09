import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DAILY_RUNS, dayOf } from './core';
import { gardenOnArrival } from './request';

// Garden on arrival (#214). Runs inside `npm run e2e`, against the e2e
// Firestore emulator, under its own project id, calling the trigger's
// body with the write's before and after as the trigger would.
const PROJECT = 'demo-mossgoblin-arrival';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'arrival-spec');
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

const T = Date.parse('2026-11-09T10:00:00Z');

/** A note as the app writes it, before its first settle. */
const fresh = (over: Record<string, unknown> = {}) => ({
  kind: 'text',
  body: 'Glaze notes\nCeladon over the bisque',
  title: 'Glaze notes',
  titleSource: 'words',
  links: [],
  tags: [],
  archived: false,
  createdAt: Timestamp.fromMillis(T),
  updatedAt: Timestamp.fromMillis(T),
  updatedBy: 'user',
  deviceId: 'phone',
  ...over,
});

/**
 * The switch as stored: on, off, a doc without the field, or no doc.
 * A string, not an optional boolean: an explicit `undefined` would take
 * a default parameter's value, and so turn the switch on.
 */
async function keep(on: 'on' | 'off' | 'unset' | 'no-doc' = 'on', key = true) {
  const ref = db.doc('users/u1/settings/assistant');
  if (on === 'on') await ref.set({ gardenOnArrival: true, updatedAt: T });
  if (on === 'off') await ref.set({ gardenOnArrival: false, updatedAt: T });
  if (on === 'unset') await ref.set({ updatedAt: T });
  if (key) await db.doc('secrets/u1').set({ anthropic: { ciphertext: 'sealed' } });
}

/** Writes the note, then settles it, and hands the settle's write to the trigger. */
async function settle(id: string, over: Record<string, unknown> = {}) {
  const ref = db.doc(`users/u1/notes/${id}`);
  const before = fresh(over);
  await ref.set(before);
  await ref.set({ settledAt: Timestamp.fromMillis(T + 300_000) }, { merge: true });
  const after = (await ref.get()).data();
  return gardenOnArrival(db, 'u1', id, before, after);
}

const note = async (id: string) => (await db.doc(`users/u1/notes/${id}`).get()).data()!;
const runs = async () => (await db.collection('users/u1/runs').get()).docs.map((d) => d.id);

describe('gardenOnArrival', () => {
  it('sends a note on its first settle, with no ask, and starts its run', async () => {
    await keep();
    expect(await settle('n1')).toBe('sent');
    const sent = await note('n1');
    expect(sent).toMatchObject({
      sendState: 'queued',
      sentOnArrival: true,
      sendRun: 'arrival-n1',
      // The text, and who wrote it, stay as Eric left them.
      body: 'Glaze notes\nCeladon over the bisque',
      updatedBy: 'user',
      deviceId: 'phone',
    });
    expect(sent['sendAsk']).toBeUndefined();
    expect(sent['sentAt']).toBeInstanceOf(Timestamp);
    const run = (await db.doc('users/u1/runs/arrival-n1').get()).data()!;
    expect(run).toMatchObject({
      kind: 'queued-note',
      noteId: 'n1',
      status: 'requested',
      arrival: true,
      steps: [],
    });
    expect((run['sentAt'] as Timestamp).isEqual(sent['sentAt'] as Timestamp)).toBe(true);
  });

  it('leaves the note alone with the switch off or never set', async () => {
    await keep('no-doc');
    expect((await db.doc('users/u1/settings/assistant').get()).exists).toBe(false);
    expect(await settle('n1')).toBe('off');
    await keep('unset');
    expect(await settle('n2')).toBe('off');
    await keep('off');
    expect(await settle('n3')).toBe('off');
    for (const id of ['n1', 'n2', 'n3']) expect((await note(id))['sendState']).toBeUndefined();
    expect(await runs()).toEqual([]);
  });

  it('leaves the note alone with no Anthropic key kept', async () => {
    await keep('on', false);
    expect(await settle('n1')).toBe('no-key');
    expect((await note('n1'))['sendState']).toBeUndefined();
    expect(await runs()).toEqual([]);
  });

  it('sends plain text notes only', async () => {
    await keep();
    for (const kind of ['template', 'recipe', 'concept', 'mealplan', 'pantry', 'clipping']) {
      expect(await settle(`k-${kind}`, { kind })).toBe('not-arrival');
    }
    expect(await settle('context', { kind: 'context' })).toBe('not-arrival');
    // Even as text, the context note is never sent.
    expect(await settle('context')).toBe('not-arrival');
    expect(await runs()).toEqual([]);
  });

  it('leaves an empty note, an archived one, and one an assistant wrote', async () => {
    await keep();
    expect(await settle('n1', { body: '  \n ' })).toBe('not-arrival');
    expect(await settle('n2', { archived: true })).toBe('not-arrival');
    expect(await settle('n3', { updatedBy: 'claude', agent: 'Claude' })).toBe('not-arrival');
    expect(await runs()).toEqual([]);
  });

  it('leaves a note already sent or done', async () => {
    await keep();
    const sentAt = Timestamp.fromMillis(T);
    expect(await settle('n1', { sendState: 'queued', sentAt, sendAsk: 'Tidy it' })).toBe(
      'not-arrival',
    );
    expect(await settle('n2', { sendState: 'done', sentAt, sendOutcome: 'Did it.' })).toBe(
      'not-arrival',
    );
    expect((await note('n1'))['sendAsk']).toBe('Tidy it');
    expect(await runs()).toEqual([]);
  });

  it('leaves a note Eric sent himself between the write and the run', async () => {
    await keep();
    const ref = db.doc('users/u1/notes/n1');
    const before = fresh();
    await ref.set({ ...before, settledAt: Timestamp.fromMillis(T + 1) });
    const after = (await ref.get()).data();
    await ref.set({ sendState: 'queued', sentAt: Timestamp.fromMillis(T + 2) }, { merge: true });
    expect(await gardenOnArrival(db, 'u1', 'n1', before, after)).toBe('already');
    expect((await note('n1'))['sentOnArrival']).toBeUndefined();
    expect(await runs()).toEqual([]);
  });

  it('leaves the note unsent and unqueued once the day’s runs are spent', async () => {
    await keep();
    await db.doc(`users/u1/usage/${dayOf(Date.now())}`).set({ runs: DAILY_RUNS });
    expect(await settle('n1')).toBe('capped');
    const left = await note('n1');
    expect(left['sendState']).toBeUndefined();
    expect(left['sentOnArrival']).toBeUndefined();
    expect(await runs()).toEqual([]);
  });

  it('never sends a note again for a later settle once taken back', async () => {
    await keep();
    expect(await settle('n1')).toBe('sent');
    const ref = db.doc('users/u1/notes/n1');
    // Take it back, as the app does, then change it and leave it again.
    const gone = FieldValue.delete();
    await ref.update({
      sendState: gone,
      sendAsk: gone,
      sentAt: gone,
      sendOutcome: gone,
      sendRun: gone,
      sentOnArrival: gone,
    });
    const before = (await ref.get()).data();
    await ref.set({ settledAt: Timestamp.fromMillis(T + 900_000) }, { merge: true });
    const after = (await ref.get()).data();
    expect(await gardenOnArrival(db, 'u1', 'n1', before, after)).toBe('not-arrival');
    expect((await note('n1'))['sendState']).toBeUndefined();
    expect(await runs()).toEqual(['arrival-n1']);
  });

  it('never sends a note again when its settle is cleared and set again', async () => {
    await keep();
    expect(await settle('n1')).toBe('sent');
    const ref = db.doc('users/u1/notes/n1');
    const gone = FieldValue.delete();
    await ref.update({ sendState: gone, sentAt: gone, sendRun: gone, sentOnArrival: gone });
    await ref.update({ settledAt: gone });
    const before = (await ref.get()).data();
    await ref.set({ settledAt: Timestamp.fromMillis(T + 900_000) }, { merge: true });
    const after = (await ref.get()).data();
    expect(await gardenOnArrival(db, 'u1', 'n1', before, after)).toBe('already');
    expect((await note('n1'))['sendState']).toBeUndefined();
    // A redelivered trigger event is the same: one run for the arrival.
    expect(await runs()).toEqual(['arrival-n1']);
  });

  it('takes a new note as a new arrival', async () => {
    await keep();
    expect(await settle('n1')).toBe('sent');
    expect(await settle('n2')).toBe('sent');
    expect((await runs()).sort()).toEqual(['arrival-n1', 'arrival-n2']);
  });
});
