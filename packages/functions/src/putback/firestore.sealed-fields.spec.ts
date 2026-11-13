import {
  type DataKey,
  type SealedField,
  aadFor,
  isSealed,
  newDataKey,
  openSealedText,
  sealText,
} from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesTools } from '../mcp/tools';
import { type Data, type Store, copy, fakeDb } from '../testing/fake-firestore';
import { PutBackRefused, SEALED_REFUSAL, putBack } from './firestore';

// Note encryption step 3d (2026-11-13): put back restores a field
// before as it was stored. A sealed value goes back as it is, never
// sealed again, once it opens as that field of the same note; one
// recorded on another note does not, and refuses the put back; a plain
// one is written in the form the rule gives (sealed-note.ts).

const UID = 'u1';
const T = Date.parse('2026-11-13T10:00:00Z');

let store: Store;
let key: DataKey;
let keyFor: ReturnType<typeof vi.fn<(uid: string) => Promise<DataKey>>>;

const notePath = (id: string) => `users/${UID}/notes/${id}`;
const stored = (id: string) => store.get(notePath(id))!;
const seal = (id: string, field: SealedField, text: string) =>
  sealText(key, aadFor(UID, id, field), text);
const open = (id: string, field: SealedField, value: unknown) =>
  openSealedText(key, aadFor(UID, id, field), String(value));

function put(id: string, over: Data = {}) {
  store.set(notePath(id), {
    kind: 'concept',
    body: '',
    title: 'Moss',
    titleSource: 'user',
    conceptType: 'other',
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

const db = () => fakeDb(store);
const tools = () => new NotesTools(db(), UID, () => T, undefined, undefined, keyFor);
const runOf = (tool: string) =>
  [...store.entries()]
    .find(([p, d]) => p.startsWith(`users/${UID}/activity/`) && d['tool'] === tool)![0]
    .split('/')
    .pop()!;
const activityAt = (runId: string) => store.get(`users/${UID}/activity/${runId}`)!;

beforeEach(() => {
  store = new Map();
  store.set(`users/${UID}/settings/modules`, { projects: { enabled: true } });
  key = newDataKey();
  keyFor = vi.fn(async () => key);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('putting back a sealed field as stored', () => {
  it('refile: the other names go back exactly as they were stored', async () => {
    const before = [seal('c-moss', 'synonyms', 'Mossy'), seal('c-moss', 'synonyms', 'Green')];
    put('c-moss', { title: seal('c-moss', 'title', 'Moss'), synonyms: before });
    await tools().refile({ id: 'c-moss', addSynonyms: ['Lichen-ish'] });
    expect(stored('c-moss')['synonyms']).toHaveLength(3);
    const runId = runOf('refile');
    expect(await putBack(db(), UID, runId, T + 60_000, undefined, keyFor)).toMatchObject({
      status: 'done',
    });
    // The very strings it had, not sealed again.
    expect(stored('c-moss')['synonyms']).toEqual(before);
    expect((before as string[]).map((n) => open('c-moss', 'synonyms', n))).toEqual([
      'Mossy',
      'Green',
    ]);
  });

  it('finish_queued: a sealed outcome before goes back as stored', async () => {
    const sentAt = Timestamp.fromMillis(T - 1000);
    const earlier = seal('q', 'sendOutcome', 'Did it last time');
    put('q', {
      kind: 'text',
      body: seal('q', 'body', 'Plans'),
      title: seal('q', 'title', 'Plans'),
      titleSource: 'words',
      sendState: 'queued',
      sendAsk: seal('q', 'sendAsk', 'Again please'),
      sentAt,
      sendOutcome: earlier,
    });
    await tools().finishQueued({
      id: 'q',
      sentAt: sentAt.toDate().toISOString(),
      outcome: 'Did it again',
    });
    expect(open('q', 'sendOutcome', stored('q')['sendOutcome'])).toBe('Did it again');
    expect(
      await putBack(db(), UID, runOf('finish_queued'), T + 60_000, undefined, keyFor),
    ).toMatchObject({ status: 'done' });
    expect(stored('q')['sendState']).toBe('queued');
    expect(stored('q')['sendOutcome']).toBe(earlier);
  });

  it('refuses a sealed value recorded on another note, and writes nothing', async () => {
    put('c-moss', {
      title: seal('c-moss', 'title', 'Moss'),
      synonyms: [seal('c-moss', 'synonyms', 'Mossy')],
    });
    put('c-fern', {
      title: seal('c-fern', 'title', 'Fern'),
      synonyms: [seal('c-fern', 'synonyms', 'Bracken')],
    });
    await tools().refile({ id: 'c-moss', addSynonyms: ['Lichen-ish'] });
    const runId = runOf('refile');
    // A record altered to put another note's sealed name onto this one.
    const record = activityAt(runId);
    const notes = record['notes'] as Data[];
    notes[0] = { ...notes[0], before: { synonyms: stored('c-fern')['synonyms'] } };
    const now = copy(stored('c-moss'));
    const err = await putBack(db(), UID, runId, T + 60_000, undefined, keyFor).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PutBackRefused);
    expect((err as Error).message).toBe(SEALED_REFUSAL);
    expect(stored('c-moss')).toEqual(now);
  });

  it('refuses a sealed value recorded as another field of the same note', async () => {
    put('c-moss', {
      title: seal('c-moss', 'title', 'Moss'),
      synonyms: [seal('c-moss', 'synonyms', 'Mossy')],
    });
    await tools().refile({ id: 'c-moss', addSynonyms: ['Lichen-ish'] });
    const runId = runOf('refile');
    const notes = activityAt(runId)['notes'] as Data[];
    notes[0] = { ...notes[0], before: { synonyms: [stored('c-moss')['title']] } };
    const now = copy(stored('c-moss'));
    await expect(putBack(db(), UID, runId, T + 60_000, undefined, keyFor)).rejects.toBeInstanceOf(
      PutBackRefused,
    );
    expect(stored('c-moss')).toEqual(now);
  });

  it('writes a plain value before in the form the rule gives: sealed beside a sealed body', async () => {
    put('c-moss', { synonyms: ['Mossy'] });
    await tools().refile({ id: 'c-moss', addSynonyms: ['Lichen-ish'] });
    expect(stored('c-moss')['synonyms']).toEqual(['Mossy', 'Lichen-ish']);
    // Sealed since, as a migration would, leaving its stamp as it was.
    const doc = stored('c-moss');
    doc['body'] = seal('c-moss', 'body', 'Notes on moss');
    doc['synonyms'] = (doc['synonyms'] as string[]).map((n) => seal('c-moss', 'synonyms', n));
    expect(await putBack(db(), UID, runOf('refile'), T + 60_000, undefined, keyFor)).toMatchObject({
      status: 'done',
    });
    const names = stored('c-moss')['synonyms'] as string[];
    expect(names.every(isSealed)).toBe(true);
    expect(names.map((n) => open('c-moss', 'synonyms', n))).toEqual(['Mossy']);
  });

  it('a plain note puts back plain, asking for no key', async () => {
    put('c-moss', { synonyms: ['Mossy'] });
    await tools().refile({ id: 'c-moss', addSynonyms: ['Lichen-ish'] });
    keyFor.mockClear();
    await putBack(db(), UID, runOf('refile'), T + 60_000, undefined, keyFor);
    expect(stored('c-moss')['synonyms']).toEqual(['Mossy']);
    expect(keyFor).not.toHaveBeenCalled();
  });
});
