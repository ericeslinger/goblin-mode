import {
  type DataKey,
  FINDINGS_MARK,
  SEAL_SENTINEL,
  aadFor,
  isSealed,
  newDataKey,
  openText,
  paths,
  recordAadFor,
  sealText,
} from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteCodec } from '../mcp/note-text';
import { NotesTools } from '../mcp/tools';
import { NoteKeysUnconfigured } from '../note-keys/client';
import { type Data, type Store, copy, fakeDb } from '../testing/fake-firestore';
import { assignedOnWrite } from './assigned';
import { firestoreRunStore } from './firestore-store';
import { executeItemRun, itemRunId } from './items';
import type { AgentModel } from './model';

// Note encryption step 3e (2026-11-13): a run's item text, item key and
// outcome are the note's words, so they are stored sealed when the note
// is, bound to the run (recordAadFor), and opened where the server reads
// them. With a plain note nothing changes and no key is asked for.

const UID = 'u1';
const ID = 'n1';
const T = Date.parse('2026-11-13T10:00:00Z');
const NOTE = `users/${UID}/notes/${ID}`;
const ITEM = 'find a good plumber @goblin';
const KEY = 'find a good plumber';
const RUN = itemRunId(ID, KEY);

let store: Store;
let key: DataKey;
let keyFor: ReturnType<typeof vi.fn<(uid: string) => Promise<DataKey>>>;
const log = { warn: vi.fn() };

const seal = (field: 'body' | 'title', text: string) => sealText(key, aadFor(UID, ID, field), text);
const runField = (runId: string, field: 'itemText' | 'itemKey' | 'outcome', value: unknown) =>
  openText(key, recordAadFor(UID, 'runs', runId, field), String(value));

function note(body: string, over: Data = {}): Data {
  return {
    kind: 'text',
    body,
    title: body.split('\n')[0],
    titleSource: 'words',
    links: [],
    tags: [],
    archived: false,
    createdAt: Timestamp.fromMillis(T - 86_400_000),
    updatedAt: Timestamp.fromMillis(T - 60_000),
    updatedBy: 'user',
    deviceId: 'phone',
    settledAt: Timestamp.fromMillis(T),
    ...over,
  };
}
const sealedNote = (body: string) => note(seal('body', body), { title: seal('title', 'Home') });

const noKey = () =>
  keyFor.mockImplementation(async () => {
    throw new NoteKeysUnconfigured('no note keys here');
  });

const runDoc = (id = RUN) => store.get(paths.run(UID, id))!;
const assign = (after: Data) =>
  assignedOnWrite(fakeDb(store), new NoteCodec(UID, keyFor), UID, ID, undefined, after, T, log);

const model: AgentModel = async () => ({
  content: [{ type: 'text', text: 'Ask the neighbours', citations: null }],
  stop_reason: 'end_turn',
  inputTokens: 10,
});

/** agentRun's item, as the trigger runs it, over the real run store. */
function runItem(runId = RUN) {
  const db = fakeDb(store);
  const tools = new NotesTools(db, UID, () => T, undefined, undefined, keyFor);
  return executeItemRun(
    {
      store: firestoreRunStore(db, keyFor),
      withModel: (_uid, use) => use(model),
      now: () => T,
      tools: () => tools,
      body: (_owner, noteId) => tools.noteBody(noteId),
    },
    UID,
    runId,
  );
}

beforeEach(() => {
  store = new Map();
  key = newDataKey();
  keyFor = vi.fn(async () => key);
  log.warn.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('an item run on a plain note', () => {
  it('stores its item text and key plain, as before, asking for no key', async () => {
    store.set(NOTE, note(`Home\n- [ ] ${ITEM}`));
    expect(await assign(store.get(NOTE)!)).toBe(1);
    expect(runDoc()).toMatchObject({ itemText: KEY, itemKey: KEY });
    expect(await runItem()).toBe('done');
    expect(runDoc()['outcome']).toBe(`${FINDINGS_MARK} 0 searches`);
    expect(keyFor).not.toHaveBeenCalled();
  });
});

describe('an item run on a sealed note', () => {
  it('stores its item text and key sealed under the run, never in the clear', async () => {
    expect(await assign(sealedNote(`Home\n- [ ] ${ITEM}`))).toBe(1);
    const run = runDoc();
    expect(isSealed(run['itemText'])).toBe(true);
    expect(isSealed(run['itemKey'])).toBe(true);
    expect(JSON.stringify(run)).not.toContain('plumber');
    expect(runField(RUN, 'itemText', run['itemText'])).toBe(KEY);
    expect(runField(RUN, 'itemKey', run['itemKey'])).toBe(KEY);
    // Bound to its field and its run: not to the note.
    expect(() =>
      openText(key, recordAadFor(UID, 'runs', RUN, 'itemText'), String(run['itemKey'])),
    ).toThrow();
    expect(() => openText(key, aadFor(UID, ID, 'body'), String(run['itemKey']))).toThrow();
  });

  it('opens its key to find the item, and stores its outcome sealed too', async () => {
    store.set(NOTE, sealedNote(`Home\n- [ ] ${ITEM}`));
    await assign(store.get(NOTE)!);
    expect(await runItem()).toBe('done');
    const outcome = runDoc()['outcome'];
    expect(isSealed(outcome)).toBe(true);
    expect(runField(RUN, 'outcome', outcome)).toBe(`${FINDINGS_MARK} 0 searches`);
    const body = openText(key, aadFor(UID, ID, 'body'), String(store.get(NOTE)!['body']));
    expect(body).toContain('Ask the neighbours');
    expect(body).toContain(`- [x] ${ITEM}`);
  });

  it('without the key: fails retryable, says nothing under the item, leaves the note', async () => {
    store.set(NOTE, sealedNote(`Home\n- [ ] ${ITEM}`));
    await assign(store.get(NOTE)!);
    const before = copy(store.get(NOTE)!) as Data;
    noKey();
    expect(await runItem()).toBe('failed');
    expect(runDoc()).toMatchObject({ status: 'failed', retryable: true });
    expect(String(runDoc()['error'])).toContain('sealed');
    expect(JSON.stringify(runDoc())).not.toContain('plumber');
    expect(store.get(NOTE)).toEqual(before);
  });

  it('a key sealed for another run does not open: fails, and not as retryable', async () => {
    store.set(NOTE, sealedNote(`Home\n- [ ] ${ITEM}`));
    await assign(store.get(NOTE)!);
    const moved = sealText(key, recordAadFor(UID, 'runs', 'other', 'itemKey'), KEY);
    store.set(paths.run(UID, RUN), { ...runDoc(), itemKey: moved });
    const before = copy(store.get(NOTE)!) as Data;
    expect(await runItem()).toBe('failed');
    expect(runDoc()['retryable']).toBeUndefined();
    expect(store.get(NOTE)).toEqual(before);
  });
});

describe("a sent note's run", () => {
  function queued(runId: string, body: Data) {
    store.set(NOTE, body);
    store.set(paths.run(UID, runId), {
      kind: 'queued-note',
      noteId: ID,
      status: 'working',
      steps: [],
      createdAt: Timestamp.fromMillis(T),
    });
  }

  it('stores its outcome plain for a plain note, with no key', async () => {
    queued('r1', note('Glaze notes'));
    await firestoreRunStore(fakeDb(store), keyFor).update(UID, 'r1', {
      status: 'done',
      outcome: 'Filed under Pottery',
    });
    expect(runDoc('r1')['outcome']).toBe('Filed under Pottery');
    expect(keyFor).not.toHaveBeenCalled();
  });

  it('stores its outcome sealed under the run when the note is sealed', async () => {
    // A plain title beside a sealed body: the note is sealed (recordForm).
    queued('r1', note(seal('body', 'Glaze notes')));
    await firestoreRunStore(fakeDb(store), keyFor).update(UID, 'r1', {
      status: 'done',
      outcome: 'Filed Glaze notes under Pottery',
    });
    const outcome = runDoc('r1')['outcome'];
    expect(String(outcome).startsWith(SEAL_SENTINEL)).toBe(true);
    expect(runField('r1', 'outcome', outcome)).toBe('Filed Glaze notes under Pottery');
  });

  it("names a sealed note's title as Sealed note in its state, even a plain title", async () => {
    queued('r1', note(seal('body', 'Glaze notes'), { sendState: 'queued' }));
    const state = await firestoreRunStore(fakeDb(store), keyFor).noteState(UID, ID);
    expect(state?.title).toBe('Sealed note');
  });
});
