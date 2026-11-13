import {
  type DataKey,
  SEAL_SENTINEL,
  type SealedField,
  aadFor,
  isSealed,
  newDataKey,
  openSealedText,
  sealText,
} from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteKeysUnconfigured } from '../note-keys/client';
import { type Store, fakeDb } from '../testing/fake-firestore';
import { SealedNoteError } from './note-text';
import { NotesTools } from './tools';

// Note encryption step 3d (2026-11-13): the other sealed fields of a
// note (other names, instructions, the Send to ask and outcome, a
// recipe's import error and source text) open on read and are written
// back in the form found, as body and title are (tools.sealed.spec.ts).

const UID = 'u1';
const T = Date.parse('2026-11-13T10:00:00Z');

type Data = Record<string, unknown>;

let store: Store;
let key: DataKey;
let keyFor: ReturnType<typeof vi.fn<(uid: string) => Promise<DataKey>>>;

const notePath = (id: string) => `users/${UID}/notes/${id}`;
const stored = (id: string) => store.get(notePath(id))!;
const seal = (id: string, field: SealedField, text: string, k = key) =>
  sealText(k, aadFor(UID, id, field), text);
const open = (id: string, field: SealedField, value: unknown) =>
  openSealedText(key, aadFor(UID, id, field), String(value));
const activity = () =>
  [...store.entries()].filter(([p]) => p.startsWith(`users/${UID}/activity/`)).map(([, d]) => d);

function put(id: string, over: Data = {}) {
  store.set(notePath(id), {
    kind: 'text',
    body: 'Some words',
    title: 'Some words',
    titleSource: 'words',
    links: [],
    tags: [],
    archived: false,
    createdAt: Timestamp.fromMillis(T - 60_000),
    updatedAt: Timestamp.fromMillis(T - 60_000),
    updatedBy: 'user',
    deviceId: 'phone',
    ...over,
  });
}

/** A concept with its title, and its other names one by one, sealed. */
function putConcept(id: string, title: string, synonyms: string[], over: Data = {}) {
  put(id, {
    kind: 'concept',
    body: '',
    title: seal(id, 'title', title),
    titleSource: 'user',
    conceptType: 'other',
    synonyms: synonyms.map((s) => seal(id, 'synonyms', s)),
    ...over,
  });
}

const tools = () => new NotesTools(fakeDb(store), UID, () => T, undefined, undefined, keyFor);

beforeEach(() => {
  store = new Map();
  store.set(`users/${UID}/settings/modules`, {
    projects: { enabled: true },
    kitchen: { enabled: true },
  });
  key = newDataKey();
  keyFor = vi.fn(async () => key);
});

const noCiphertext = (value: unknown) => expect(JSON.stringify(value)).not.toContain(SEAL_SENTINEL);

describe('the other sealed fields, with the key', () => {
  it('get_note opens the instructions it gives in takes', async () => {
    put('a', {
      body: seal('a', 'body', 'Reading list'),
      title: seal('a', 'title', 'Reading list'),
      instructions: seal('a', 'instructions', 'Newest first, one line each.'),
      mode: 'list',
    });
    const note = await tools().getNote({ id: 'a' });
    expect(JSON.stringify(note)).toContain('Newest first, one line each.');
    noCiphertext(note);
  });

  it('update_note keeps sealed instructions sealed, and plain ones plain with no key', async () => {
    put('a', { instructions: seal('a', 'instructions', 'Old way') });
    put('b', { instructions: 'Plain way' });
    const t = tools();
    await t.updateNote({ id: 'a', instructions: 'New way' });
    expect(isSealed(stored('a')['instructions'])).toBe(true);
    expect(open('a', 'instructions', stored('a')['instructions'])).toBe('New way');
    keyFor.mockClear();
    await tools().updateNote({ id: 'b', instructions: 'Still plain' });
    expect(stored('b')['instructions']).toBe('Still plain');
    expect(keyFor).not.toHaveBeenCalled();
  });

  it('seals instructions written beside a sealed body, as a title is (no field plainer than its body)', async () => {
    put('a', { body: seal('a', 'body', 'Private'), title: seal('a', 'title', 'Private') });
    await tools().updateNote({ id: 'a', instructions: 'Tidy it' });
    expect(open('a', 'instructions', stored('a')['instructions'])).toBe('Tidy it');
  });

  it('the name index reaches a concept by a sealed other name', async () => {
    putConcept('c-moss', 'Moss', ['Mossy', 'The green stuff']);
    put('n', { body: 'See [[Mossy]]', title: 'See' });
    const t = tools();
    await t.updateNote({ id: 'n', body: 'See [[Mossy]] and [[The green stuff]]' });
    expect(stored('n')['links']).toEqual(['c-moss']);
    const concepts = await t.listConcepts({});
    expect(concepts).toEqual([
      expect.objectContaining({
        id: 'c-moss',
        title: 'Moss',
        synonyms: ['Mossy', 'The green stuff'],
      }),
    ]);
    noCiphertext(concepts);
    // A sealed other name is taken, as a plain one is.
    await expect(t.createConcept({ name: 'Mossy' })).rejects.toThrow(/already a name/);
  });

  it('refile: a name added to sealed other names is sealed, element by element, and not said in the clear', async () => {
    putConcept('c-moss', 'Moss', ['Mossy']);
    const before = stored('c-moss')['synonyms'];
    await tools().refile({ id: 'c-moss', addSynonyms: ['Lichen-ish'] });
    const names = stored('c-moss')['synonyms'] as string[];
    expect(names).toHaveLength(2);
    expect(names.every(isSealed)).toBe(true);
    expect(names.map((n) => open('c-moss', 'synonyms', n))).toEqual(['Mossy', 'Lichen-ish']);
    const [entry] = activity();
    expect(entry['summary']).toBe('Refiled a sealed note: added another name');
    expect(JSON.stringify(entry)).not.toContain('Lichen');
    expect(JSON.stringify(entry)).not.toContain('Mossy');
    // Kept for put back as stored: the sealed list it replaced.
    expect((entry['notes'] as Data[])[0]['before']).toEqual({ synonyms: before });
  });

  it('refile: other names beside a plain title stay plain, said as before', async () => {
    put('c-fern', { kind: 'concept', title: 'Fern', titleSource: 'user', synonyms: ['Bracken'] });
    await tools().refile({ id: 'c-fern', addSynonyms: ['Frond'] });
    expect(stored('c-fern')['synonyms']).toEqual(['Bracken', 'Frond']);
    expect(activity()[0]['summary']).toBe('Refiled Fern: added another name: Frond');
    expect(keyFor).not.toHaveBeenCalled();
  });

  it('list_queue opens the ask; finish_queued seals the outcome and leaves it out of the entry', async () => {
    const sentAt = Timestamp.fromMillis(T - 1000);
    put('q', {
      body: seal('q', 'body', 'Plans'),
      title: seal('q', 'title', 'Plans'),
      sendState: 'queued',
      sendAsk: seal('q', 'sendAsk', 'Make a packing list'),
      sentAt,
    });
    const t = tools();
    const queue = await t.listQueue({});
    expect(queue).toEqual([expect.objectContaining({ id: 'q', ask: 'Make a packing list' })]);
    noCiphertext(queue);
    await t.finishQueued({
      id: 'q',
      sentAt: sentAt.toDate().toISOString(),
      outcome: 'Wrote the packing list',
    });
    expect(open('q', 'sendOutcome', stored('q')['sendOutcome'])).toBe('Wrote the packing list');
    const [entry] = activity();
    expect(entry['summary']).toBe('Did a sealed note sent to it');
    expect(JSON.stringify(entry)).not.toContain('packing');
  });

  it('finish_queued still cuts the outcome to its plain-text limit before sealing it', async () => {
    const sentAt = Timestamp.fromMillis(T - 1000);
    put('q', {
      body: seal('q', 'body', 'Plans'),
      title: seal('q', 'title', 'Plans'),
      sendState: 'queued',
      sentAt,
    });
    await tools().finishQueued({
      id: 'q',
      sentAt: sentAt.toDate().toISOString(),
      outcome: 'x'.repeat(400),
    });
    expect(open('q', 'sendOutcome', stored('q')['sendOutcome'])).toBe('x'.repeat(300));
  });

  it('a recipe import fills a sealed recipe in sealed: its source text and import error too', async () => {
    const recipe = {
      kind: 'recipe',
      title: seal('r', 'title', 'example.com'),
      body: seal('r', 'body', 'My own notes on it'),
      titleSource: 'words',
      source: { url: 'https://example.com/soup' },
      importState: 'requested',
    };
    put('r', recipe);
    const t = tools();
    await t.finishRecipeImport('r', async () => ({
      name: 'Soup',
      ingredients: ['water', 'salt'],
      method: ['Boil the water.'],
    }));
    const source = stored('r')['source'] as Data;
    expect(source['url']).toBe('https://example.com/soup');
    expect(isSealed(source['text'])).toBe(true);
    expect(open('r', 'source.text', source['text'])).toContain('water');
    expect(open('r', 'body', stored('r')['body'])).toBe('My own notes on it');
    noCiphertext(await t.getNote({ id: 'r' }));

    put('r2', { ...recipe, title: seal('r2', 'title', 'x'), body: seal('r2', 'body', 'y') });
    await tools().finishRecipeImport('r2', async () => {
      throw new Error('the page would not load');
    });
    expect(stored('r2')['importState']).toBe('failed');
    expect(open('r2', 'importError', stored('r2')['importError'])).toBe('the page would not load');
  });

  it('suggest_changes stores no name proposed for a concept whose names are sealed', async () => {
    putConcept('c-moss', 'Moss', ['Mossy']);
    const out = await tools().suggestChanges({
      proposals: [
        { kind: 'refile', id: 'c-moss', synonyms: ['Lichen-ish'], reason: 'Another name' },
        { kind: 'refile', id: 'c-moss', type: 'mood', synonyms: ['Green'], reason: 'A mood' },
      ],
    });
    expect(out.stored).toHaveLength(1);
    const proposals = [...store.entries()]
      .filter(([p]) => p.startsWith(`users/${UID}/proposals/`))
      .map(([, d]) => d);
    expect(proposals).toEqual([expect.objectContaining({ kind: 'refile', conceptType: 'mood' })]);
    expect(JSON.stringify(proposals)).not.toMatch(/Lichen|Green|green|lichen/);
  });
});

describe('the other sealed fields, without the key or not opening', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('a concept whose other names do not open is locked: listed as sealed, its names unknown', async () => {
    const other = newDataKey();
    put('c-moss', {
      kind: 'concept',
      body: '',
      title: 'Moss',
      titleSource: 'user',
      synonyms: [sealText(other, aadFor(UID, 'c-moss', 'synonyms'), 'Mossy')],
    });
    put('n', { body: 'See [[Mossy]]', title: 'See', links: ['c-moss'] });
    const t = tools();
    const concepts = await t.listConcepts({});
    expect(concepts).toEqual([
      expect.objectContaining({
        id: 'c-moss',
        title: 'Moss',
        synonyms: [],
        sealed: expect.any(String),
      }),
    ]);
    noCiphertext(concepts);
    await expect(t.getNote({ id: 'c-moss' })).rejects.toBeInstanceOf(SealedNoteError);
    // Its names cannot be read, so a create that might take one is refused,
    await expect(t.createConcept({ name: 'Anything' })).rejects.toThrow(/is refused for now/);
    // and a stored link to it is kept when the links are worked out again.
    await t.updateNote({ id: 'n', body: 'See [[Mossy]] again' });
    expect(stored('n')['links']).toContain('c-moss');
    // Nothing writes over it.
    await expect(t.refile({ id: 'c-moss', addSynonyms: ['Lichen'] })).rejects.toBeInstanceOf(
      SealedNoteError,
    );
    expect(stored('c-moss')['synonyms']).toHaveLength(1);
  });

  it('list_queue says sealed for an ask it cannot open, and gives no ask', async () => {
    keyFor.mockImplementation(async () => {
      throw new NoteKeysUnconfigured('no note keys here');
    });
    put('q', {
      sendState: 'queued',
      sendAsk: seal('q', 'sendAsk', 'Do the thing'),
      sentAt: Timestamp.fromMillis(T - 1000),
    });
    const queue = await tools().listQueue({});
    expect(queue).toEqual([
      expect.objectContaining({ id: 'q', title: 'Some words', sealed: expect.any(String) }),
    ]);
    expect(queue[0]).not.toHaveProperty('ask');
    noCiphertext(queue);
  });

  it('instructions that do not open lock the note: no write over them', async () => {
    keyFor.mockImplementation(async () => {
      throw new NoteKeysUnconfigured('no note keys here');
    });
    const sealed = seal('a', 'instructions', 'Keep it short');
    put('a', { instructions: sealed });
    const t = tools();
    await expect(t.getNote({ id: 'a' })).rejects.toBeInstanceOf(SealedNoteError);
    await expect(t.updateNote({ id: 'a', instructions: 'Other' })).rejects.toBeInstanceOf(
      SealedNoteError,
    );
    expect(stored('a')['instructions']).toBe(sealed);
  });
});
