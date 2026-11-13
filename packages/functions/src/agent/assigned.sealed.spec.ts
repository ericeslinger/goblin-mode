import {
  type DataKey,
  aadFor,
  isSealed,
  newDataKey,
  openText,
  paths,
  sealText,
} from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteCodec } from '../mcp/note-text';
import { NotesTools } from '../mcp/tools';
import { NoteKeysUnconfigured } from '../note-keys/client';
import { type Data, type Store, copy, fakeDb } from '../testing/fake-firestore';
import { assignedOnWrite } from './assigned';
import type { RunStore } from './core';
import { executeItemRun, itemRunId } from './items';
import type { AgentModel } from './model';
import { gardenOnArrival } from './request';

// Note encryption step 3c (2026-11-13): itemAssigned, agentRun's item
// and noteArrived read a sealed body opened, through one codec, and
// leave a note they cannot open as stored. Over the in-memory
// Firestore, with a fake key source.

const UID = 'u1';
const ID = 'n1';
const T = Date.parse('2026-11-13T10:00:00Z');
const NOTE = `users/${UID}/notes/${ID}`;
const ITEM = 'find a good plumber @goblin';
const KEY = 'find a good plumber';

let store: Store;
let key: DataKey;
let keyFor: ReturnType<typeof vi.fn<(uid: string) => Promise<DataKey>>>;
const log = { warn: vi.fn() };

const seal = (field: 'body' | 'title', text: string) => sealText(key, aadFor(UID, ID, field), text);
const open = (field: 'body' | 'title', value: unknown) =>
  openText(key, aadFor(UID, ID, field), String(value));

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
    ...over,
  };
}
const sealedNote = (body: string, over: Data = {}) =>
  note(seal('body', body), { title: seal('title', body.split('\n')[0]), ...over });

const noKey = () =>
  keyFor.mockImplementation(async () => {
    throw new NoteKeysUnconfigured('no note keys here');
  });

const runs = () => [...store.keys()].filter((p) => p.startsWith(`users/${UID}/runs/`));
const settled = { settledAt: Timestamp.fromMillis(T) };

beforeEach(() => {
  store = new Map();
  key = newDataKey();
  keyFor = vi.fn(async () => key);
  log.warn.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const assign = (after: Data) =>
  assignedOnWrite(fakeDb(store), new NoteCodec(UID, keyFor), UID, ID, undefined, after, T, log);

describe('itemAssigned', () => {
  it('reads a plain body as before, with no key', async () => {
    expect(await assign(note(`Home\n- [ ] ${ITEM}`, settled))).toBe(1);
    expect(runs()).toEqual([paths.run(UID, itemRunId(ID, KEY))]);
    expect(keyFor).not.toHaveBeenCalled();
  });

  it('opens a sealed body to find its items', async () => {
    expect(await assign(sealedNote(`Home\n- [ ] ${ITEM}`, settled))).toBe(1);
    expect(runs()).toEqual([paths.run(UID, itemRunId(ID, KEY))]);
  });

  it('a body it cannot open starts nothing, says so once, and does not throw', async () => {
    noKey();
    expect(await assign(sealedNote(`Home\n- [ ] ${ITEM}`, settled))).toBe('sealed');
    expect(runs()).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('itemAssigned'), {
      noteId: ID,
      reason: 'no-key',
    });
  });
});

describe("agentRun's assigned item", () => {
  const model: AgentModel = async () => ({
    content: [{ type: 'text', text: 'Ask the neighbours', citations: null }],
    stop_reason: 'end_turn',
    inputTokens: 10,
  });

  function run() {
    const update = vi.fn(async (_u: string, _r: string, _f: Record<string, unknown>) => undefined);
    const runStore = {
      claim: vi.fn(async () => ({
        status: 'claimed' as const,
        run: { kind: 'item', noteId: ID, itemKey: KEY, status: 'working' },
      })),
      update,
      step: vi.fn(async () => undefined),
      noteState: vi.fn(async () => undefined),
    } satisfies RunStore;
    const tools = new NotesTools(fakeDb(store), UID, () => T, undefined, undefined, keyFor);
    const asked = vi.fn();
    const withModel = <R>(_uid: string, use: (m: AgentModel) => Promise<R>) => {
      asked();
      return use(model);
    };
    const outcome = executeItemRun(
      {
        store: runStore,
        withModel,
        now: () => T,
        tools: () => tools,
        body: (_owner, noteId) => tools.noteBody(noteId),
      },
      UID,
      'r1',
    );
    return { outcome, update, asked };
  }

  it('writes the findings under the item of a sealed note, sealed again', async () => {
    store.set(NOTE, sealedNote(`Home\n- [ ] ${ITEM}`));
    const { outcome } = run();
    expect(await outcome).toBe('done');
    const body = store.get(NOTE)!['body'];
    expect(isSealed(body)).toBe(true);
    expect(open('body', body)).toContain('Ask the neighbours');
    expect(open('body', body)).toContain(`- [x] ${ITEM}`);
    expect(keyFor).toHaveBeenCalledTimes(1);
  });

  it('a note it cannot open is left as stored, the run failed and retried at a later settle', async () => {
    noKey();
    const stored = sealedNote(`Home\n- [ ] ${ITEM}`);
    store.set(NOTE, copy(stored) as Data);
    const { outcome, update, asked } = run();
    expect(await outcome).toBe('failed');
    expect(asked).not.toHaveBeenCalled();
    expect(store.get(NOTE)).toEqual(stored);
    expect(update).toHaveBeenLastCalledWith(
      UID,
      'r1',
      expect.objectContaining({ status: 'failed', retryable: true }),
    );
  });
});

describe('noteArrived', () => {
  const arrival = (body: unknown) =>
    gardenOnArrival(
      fakeDb(store),
      UID,
      ID,
      { settledAt: undefined },
      note(String(body), { ...settled }),
      new NoteCodec(UID, keyFor),
    );

  it('opens a sealed body to see whether it has words', async () => {
    // Past the arrival check: no settings, so Garden on arrival is off.
    expect(await arrival(seal('body', 'Plumber on Tuesday'))).toBe('off');
    expect(await arrival(seal('body', '  \n '))).toBe('not-arrival');
  });

  it('asks for no key for a plain note, or one that does not arrive', async () => {
    expect(await arrival('Plumber on Tuesday')).toBe('off');
    expect(
      await gardenOnArrival(
        fakeDb(store),
        UID,
        ID,
        settled,
        note(seal('body', 'x'), settled),
        new NoteCodec(UID, keyFor),
      ),
    ).toBe('not-arrival');
    expect(keyFor).not.toHaveBeenCalled();
  });

  it('a body it cannot open is left as it is', async () => {
    noKey();
    expect(await arrival(seal('body', 'Plumber on Tuesday'))).toBe('sealed');
    expect(store.size).toBe(0);
  });
});
