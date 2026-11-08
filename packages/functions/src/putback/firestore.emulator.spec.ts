import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { textHash } from '@mossgoblin/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotesTools } from '../mcp/tools';
import { DAILY_PUT_BACKS, putBack } from './firestore';

// Runs inside `npm run e2e`, against the e2e Firestore emulator, under
// its own project id. No functions run here, so the texts noteHistory
// would remember are written by `remember`.
const PROJECT = 'demo-mossgoblin-putback';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'putback-spec');
let db: Firestore;
const T = Date.parse('2026-11-08T10:00:00Z');
const DAY = 86_400_000;

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

async function eric(id: string, body: string, over: Record<string, unknown> = {}) {
  await db.doc(`users/u1/notes/${id}`).set({
    kind: 'text',
    body,
    title: body.split('\n')[0],
    titleSource: 'words',
    links: [],
    tags: [],
    archived: false,
    createdAt: Timestamp.fromMillis(T - DAY),
    updatedAt: Timestamp.fromMillis(T - DAY),
    updatedBy: 'user',
    deviceId: 'phone',
    ...over,
  });
}

/** What noteHistory keeps for a write: the text it replaced. */
async function remember(id: string, body: string, where: 'replaced' | 'history' = 'replaced') {
  if (where === 'replaced') {
    await db.doc(`users/u1/notes/${id}/replaced/${textHash(body)}`).set({
      body,
      writtenAt: Timestamp.fromMillis(T - DAY),
      expireAt: Timestamp.fromMillis(T + DAY),
    });
  } else {
    await db.collection(`users/u1/notes/${id}/history`).add({
      body,
      title: body.split('\n')[0],
      updatedAt: Timestamp.fromMillis(T - DAY),
      updatedBy: 'user',
      deviceId: 'phone',
      savedAt: Timestamp.fromMillis(T),
      reason: 'device',
    });
  }
}

const tools = (at: number) => new NotesTools(db, 'u1', () => at);
const read = async (id: string) => (await db.doc(`users/u1/notes/${id}`).get()).data()!;

/** The id of the newest run of `tool`. */
async function runOf(tool: string): Promise<string> {
  const snap = await db.collection('users/u1/activity').where('tool', '==', tool).get();
  const docs = snap.docs.sort((a, b) => b.get('at').toMillis() - a.get('at').toMillis());
  return docs[0].id;
}

describe('putBack', () => {
  it('puts back a line edit from History, verbatim, and records itself', async () => {
    await eric('a', 'Shopping\n\n## Produce\n- [ ] limes');
    await tools(T).addLines({ id: 'a', heading: 'Produce', lines: ['- [ ] oats'] });
    expect(String((await read('a'))['body'])).toContain('oats');
    await remember('a', 'Shopping\n\n## Produce\n- [ ] limes', 'history');
    const runId = await runOf('add_lines');

    const result = await putBack(db, 'u1', runId, T + 60_000);
    expect(result).toEqual({ status: 'done', id: `putback-${runId}`, notes: 1 });
    const a = await read('a');
    expect(a['body']).toBe('Shopping\n\n## Produce\n- [ ] limes');
    expect(a).toMatchObject({
      updatedBy: 'claude',
      agent: 'Mossgoblin',
      deviceId: `agent:Mossgoblin~putback-${runId}`,
      archived: false,
    });
    const record = (await db.doc(`users/u1/activity/putback-${runId}`).get()).data()!;
    expect(record).toMatchObject({
      tool: 'put_back',
      agent: 'Mossgoblin',
      summary: expect.stringMatching(/^Put back “/),
      notes: [{ id: 'a', title: 'Shopping' }],
      reminders: [],
    });
    expect((await db.doc('users/u1/usage/2026-11-08').get()).get('putBacks')).toBe(1);

    // A second tap says so and writes nothing.
    expect(await putBack(db, 'u1', runId, T + 120_000)).toEqual({
      status: 'already',
      id: `putback-${runId}`,
      notes: 0,
    });
    expect((await read('a'))['updatedAt'].toMillis()).toBe(T + 60_000);
  });

  it('restores what a run archived, and archives what one made', async () => {
    await eric('a', 'Kiln log\nCone 6.');
    await tools(T).archiveNote({ id: 'a' });
    await putBack(db, 'u1', await runOf('archive_note'), T + 1000);
    expect((await read('a'))['archived']).toBe(false);

    const made = await tools(T + 2000).createNote({ body: 'Filed by Claude\nabout trains' });
    await putBack(db, 'u1', await runOf('create_note'), T + 3000);
    expect(await read(made.id)).toMatchObject({
      archived: true,
      body: 'Filed by Claude\nabout trains',
    });
  });

  it('puts back a split: the note whole again, its pieces archived', async () => {
    await eric('s', 'Trip\n\nPack the tent.\n\nBook the ferry.');
    const split = await tools(T).splitNote({
      id: 's',
      parts: ['Trip\n\nPack the tent.', 'Book the ferry.'],
    });
    await remember('s', 'Trip\n\nPack the tent.\n\nBook the ferry.');
    await putBack(db, 'u1', await runOf('split_note'), T + 1000);
    expect(await read('s')).toMatchObject({
      body: 'Trip\n\nPack the tent.\n\nBook the ferry.',
      title: 'Trip',
      archived: false,
    });
    expect((await read(split.pieces[0].id))['archived']).toBe(true);
  });

  it('puts back a merge, and puts back the put back', async () => {
    await eric('x', 'Kiln log\nCone 6.');
    await eric('y', 'Firing notes\nShelf 2.');
    const merged = await tools(T).mergeNotes({ ids: ['x', 'y'] });
    const runId = await runOf('merge_notes');

    await putBack(db, 'u1', runId, T + 1000);
    expect((await read(merged.id))['archived']).toBe(true);
    for (const id of ['x', 'y']) {
      const n = await read(id);
      expect(n['archived']).toBe(false);
      expect(n['mergedInto']).toBeUndefined();
    }

    // Putting back the put back merges them again.
    const again = await putBack(db, 'u1', `putback-${runId}`, T + 2000);
    expect(again).toMatchObject({ status: 'done', id: `putback-putback-${runId}`, notes: 3 });
    expect((await read(merged.id))['archived']).toBe(false);
    expect(await read('x')).toMatchObject({ archived: true, mergedInto: merged.id });
  });

  it('puts back a put back of text from the text it wrote over', async () => {
    await eric('a', 'Shopping\n\n## Produce\n- [ ] limes');
    await tools(T).addLines({ id: 'a', heading: 'Produce', lines: ['- [ ] oats'] });
    const after = String((await read('a'))['body']);
    await remember('a', 'Shopping\n\n## Produce\n- [ ] limes');
    const runId = await runOf('add_lines');
    await putBack(db, 'u1', runId, T + 1000);
    await remember('a', after);
    await putBack(db, 'u1', `putback-${runId}`, T + 2000);
    expect((await read('a'))['body']).toBe(after);
  });

  it('leaves a note Eric wrote since alone, and refuses when nothing is left', async () => {
    await eric('a', 'Shopping\n\n## Produce\n- [ ] limes');
    await tools(T).addLines({ id: 'a', heading: 'Produce', lines: ['- [ ] oats'] });
    await remember('a', 'Shopping\n\n## Produce\n- [ ] limes');
    await db.doc('users/u1/notes/a').update({
      body: 'Shopping\n\n## Produce\n- [ ] limes\n- [ ] oats\n- [ ] figs',
      updatedAt: Timestamp.fromMillis(T + 500),
      updatedBy: 'user',
      deviceId: 'phone',
    });
    const runId = await runOf('add_lines');
    await expect(putBack(db, 'u1', runId, T + 1000)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringMatching(/changed since/),
    });
    expect((await read('a'))['body']).toContain('figs');
    expect((await db.doc(`users/u1/activity/putback-${runId}`).get()).exists).toBe(false);
  });

  it('refuses a run that is not there, filing, and a day past its budget', async () => {
    await expect(putBack(db, 'u1', 'nope', T)).rejects.toMatchObject({ code: 'not-found' });
    await eric('a', 'Kiln log\nCone 6.');
    await tools(T).refile({ id: 'a', addTags: ['pottery'] });
    await expect(putBack(db, 'u1', await runOf('refile'), T)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    await tools(T).archiveNote({ id: 'a' });
    await db.doc('users/u1/usage/2026-11-08').set({ putBacks: DAILY_PUT_BACKS });
    await expect(putBack(db, 'u1', await runOf('archive_note'), T + 1000)).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
  });

  it('reads only the caller’s own runs', async () => {
    await eric('a', 'Kiln log\nCone 6.');
    await tools(T).archiveNote({ id: 'a' });
    await expect(putBack(db, 'u2', await runOf('archive_note'), T + 1000)).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
