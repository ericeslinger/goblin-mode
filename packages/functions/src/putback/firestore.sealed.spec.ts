import {
  CONTEXT_ID,
  type DataKey,
  SEAL_SENTINEL,
  aadFor,
  firstWordsTitle,
  isSealed,
  newDataKey,
  openText,
  putBackId,
  sealText,
  textHash,
} from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesTools } from '../mcp/tools';
import { NoteKeysUnconfigured } from '../note-keys/client';
import { type Data, type Store, copy, fakeDb } from '../testing/fake-firestore';
import { PutBackRefused, SEALED_REFUSAL, putBack, reroute } from './firestore';

// Note encryption step 3c (2026-11-13): put back and reroute open a
// sealed note, and the copies of its text, with one codec for the call,
// write back in its form, and refuse, writing nothing, when a note they
// need does not open. Over the in-memory Firestore, with a fake key
// source.

const UID = 'u1';
const T = Date.parse('2026-11-13T10:00:00Z');

let store: Store;
let key: DataKey;
let keyFor: ReturnType<typeof vi.fn<(uid: string) => Promise<DataKey>>>;

const notePath = (id: string) => `users/${UID}/notes/${id}`;
const stored = (id: string) => store.get(notePath(id))!;
const seal = (id: string, field: 'body' | 'title', text: string) =>
  sealText(key, aadFor(UID, id, field), text);
const opened = (id: string, field: 'body' | 'title') =>
  openText(key, aadFor(UID, id, field), String(stored(id)[field]));

function put(id: string, body: string, over: Data = {}) {
  store.set(notePath(id), {
    kind: 'text',
    body,
    title: body.split('\n')[0],
    titleSource: 'words',
    links: [],
    tags: [],
    archived: false,
    createdAt: Timestamp.fromMillis(T - 86_400_000),
    updatedAt: Timestamp.fromMillis(T - 86_400_000),
    updatedBy: 'user',
    deviceId: 'phone',
    ...over,
  });
}
const putSealed = (id: string, body: string, over: Data = {}) =>
  put(id, seal(id, 'body', body), { title: seal(id, 'title', body.split('\n')[0]), ...over });

const db = () => fakeDb(store);
const tools = () => new NotesTools(db(), UID, () => T, undefined, undefined, keyFor);

/** What noteHistory keeps for a write: the text it replaced, in the note's stored form. */
function remember(id: string, text: string, storedBody: string) {
  store.set(`${notePath(id)}/replaced/${textHash(text)}`, {
    body: storedBody,
    writtenAt: Timestamp.fromMillis(T - 1000),
  });
}

/** The id of the run of `tool`. */
const runOf = (tool: string) =>
  [...store.entries()]
    .find(([p, d]) => p.startsWith(`users/${UID}/activity/`) && d['tool'] === tool)![0]
    .split('/')
    .pop()!;

const noKey = () =>
  keyFor.mockImplementation(async () => {
    throw new NoteKeysUnconfigured('NOTE_KEYS_SERVICE is not set');
  });

beforeEach(() => {
  store = new Map();
  store.set(`users/${UID}/settings/modules`, { projects: { enabled: true } });
  key = newDataKey();
  keyFor = vi.fn(async () => key);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('putBack', () => {
  it('a plain note as before, never asking for a key', async () => {
    const text = 'Shopping\n- [ ] limes';
    put('a', text);
    await tools().addLines({ id: 'a', lines: ['- [ ] oats'] });
    remember('a', text, text);
    keyFor.mockClear();
    const runId = runOf('add_lines');
    expect(await putBack(db(), UID, runId, T + 60_000, undefined, keyFor)).toMatchObject({
      status: 'done',
      notes: 1,
    });
    expect(stored('a')['body']).toBe(text);
    expect(store.get(`users/${UID}/activity/${putBackId(runId)}`)!['notes']).toEqual([
      { id: 'a', title: 'Shopping' },
    ]);
    expect(keyFor).not.toHaveBeenCalled();
  });

  it("puts back a sealed note's earlier text, sealed again, from its replaced copy", async () => {
    const text = 'Dentist Tuesday\nbring forms';
    putSealed('a', text);
    const before = String(stored('a')['body']);
    await tools().addLines({ id: 'a', lines: ['and the card'] });
    remember('a', text, before);
    const runId = runOf('add_lines');
    await putBack(db(), UID, runId, T + 60_000, undefined, keyFor);
    const a = stored('a');
    expect(isSealed(a['body'])).toBe(true);
    expect(opened('a', 'body')).toBe(text);
    expect(isSealed(a['title'])).toBe(true);
    expect(opened('a', 'title')).toBe(firstWordsTitle(text));
    const record = store.get(`users/${UID}/activity/${putBackId(runId)}`)!;
    expect(record['notes']).toEqual([{ id: 'a', title: 'Sealed note' }]);
    expect(JSON.stringify(record)).not.toContain('Dentist');
    expect(JSON.stringify(record)).not.toContain(SEAL_SENTINEL);
    // The correction goes to the context note, made plain as the app makes it.
    expect(store.get(notePath(CONTEXT_ID))?.['body']).toEqual(expect.stringContaining('Put back'));
  });

  it('finds the text in a sealed History version, opened with the note’s aad', async () => {
    const text = 'Garden plan\n- [ ] kale';
    putSealed('a', text);
    const before = String(stored('a')['body']);
    await tools().addLines({ id: 'a', lines: ['- [ ] chard'] });
    store.set(`${notePath('a')}/history/v1`, {
      body: before,
      title: stored('a')['title'],
      updatedBy: 'user',
      deviceId: 'phone',
      savedAt: Timestamp.fromMillis(T),
      reason: 'author',
    });
    await putBack(db(), UID, runOf('add_lines'), T + 60_000, undefined, keyFor);
    expect(opened('a', 'body')).toBe(text);
  });

  it('a note it cannot open refuses the put back and writes nothing', async () => {
    const text = 'Private\n- [ ] x';
    putSealed('a', text);
    const before = String(stored('a')['body']);
    await tools().addLines({ id: 'a', lines: ['more'] });
    remember('a', text, before);
    const snapshot = copy([...store.entries()]);
    noKey();
    const err = await putBack(db(), UID, runOf('add_lines'), T + 60_000, undefined, keyFor).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PutBackRefused);
    expect((err as PutBackRefused).code).toBe('failed-precondition');
    expect((err as Error).message).toBe(SEALED_REFUSAL);
    expect([...store.entries()]).toEqual(snapshot);
  });
});

describe('reroute', () => {
  function mergedAndPutBack() {
    put('p', 'Garden', { kind: 'concept', conceptType: 'project', titleSource: 'user' });
    putSealed('a', 'Sow the kale');
    putSealed('b', 'Mulch the beds');
    return tools()
      .mergeNotes({ ids: ['a', 'b'] })
      .then(async () => {
        const runId = runOf('merge_notes');
        await putBack(db(), UID, runId, T + 60_000, undefined, keyFor);
        return putBackId(runId);
      });
  }

  it("files a sealed note's text under the project, sealed again, its record labelled", async () => {
    const putBackRun = await mergedAndPutBack();
    expect(opened('a', 'body')).toBe('Sow the kale');
    const result = await reroute(db(), UID, putBackRun, 'p', T + 120_000, undefined, keyFor);
    expect(result).toMatchObject({ status: 'done', notes: 2 });
    expect(isSealed(stored('a')['body'])).toBe(true);
    expect(opened('a', 'body')).toBe('Sow the kale\n\nSee also [[Garden]]');
    expect(stored('a')['links']).toEqual(['p']);
    const record = [...store.values()].find((d) => d['tool'] === 'reroute')!;
    expect(record['summary']).toBe('Filed 2 notes under Garden');
    expect(record['notes']).toEqual([
      expect.objectContaining({ id: 'a', title: 'Sealed note', before: expect.anything() }),
      expect.objectContaining({ id: 'b', title: 'Sealed note' }),
    ]);
    const before = (record['notes'] as { before: Data }[])[0].before;
    expect(before['body']).toBe(textHash('Sow the kale'));
    expect(JSON.stringify(record)).not.toContain('kale');
  });

  it('a note it cannot open refuses, writing nothing', async () => {
    const putBackRun = await mergedAndPutBack();
    const snapshot = copy([...store.entries()]);
    noKey();
    await expect(
      reroute(db(), UID, putBackRun, 'p', T + 120_000, undefined, keyFor),
    ).rejects.toThrow(SEALED_REFUSAL);
    expect([...store.entries()]).toEqual(snapshot);
  });
});
