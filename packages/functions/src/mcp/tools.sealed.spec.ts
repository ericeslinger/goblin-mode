import {
  type DataKey,
  SEAL_SENTINEL,
  aadFor,
  isSealed,
  newDataKey,
  openText,
  sealText,
  textHash,
} from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteKeysUnconfigured } from '../note-keys/client';
import { type Store, copy, fakeDb } from '../testing/fake-firestore';
import { SealedNoteError } from './note-text';
import { NotesTools, ToolError } from './tools';

// Note encryption step 3b (2026-11-12): the tools open sealed notes and
// keep each in the form they found it. Against a small in-memory
// Firestore (testing/fake-firestore.ts), with a fake key source, so no
// emulator is needed.

const UID = 'u1';
const T = Date.parse('2026-11-12T10:00:00Z');

type Data = Record<string, unknown>;

// ---- The garden. ----

let store: Store;
let key: DataKey;
let keyFor: ReturnType<typeof vi.fn<(uid: string) => Promise<DataKey>>>;

const notePath = (id: string) => `users/${UID}/notes/${id}`;
const stored = (id: string) => store.get(notePath(id))!;
const seal = (id: string, field: 'body' | 'title', text: string, k = key) =>
  sealText(k, aadFor(UID, id, field), text);
const opened = (id: string, field: 'body' | 'title', k = key) =>
  openText(k, aadFor(UID, id, field), String(stored(id)[field]));
const activity = () =>
  [...store.entries()].filter(([p]) => p.startsWith(`users/${UID}/activity/`)).map(([, d]) => d);

function put(id: string, body: string, over: Data = {}) {
  store.set(notePath(id), {
    kind: 'text',
    body,
    title: body.split('\n')[0],
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

/** A note with its body, and its title unless `title` is false, sealed. */
function putSealed(id: string, body: string, over: Data = {}, title = true) {
  const plainTitle = String(over['title'] ?? body.split('\n')[0]);
  put(id, seal(id, 'body', body), {
    ...over,
    title: title ? seal(id, 'title', plainTitle) : plainTitle,
  });
}

const tools = () => new NotesTools(fakeDb(store), UID, () => T, undefined, undefined, keyFor);

beforeEach(() => {
  store = new Map();
  store.set(`users/${UID}/settings/modules`, { projects: { enabled: true } });
  key = newDataKey();
  keyFor = vi.fn(async () => key);
});

/** Nothing of a sealed value in what a tool said. */
function noCiphertext(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(SEAL_SENTINEL);
}

const listed = <T>(r: T[] | { items: T[] }): T[] => (Array.isArray(r) ? r : r.items);

describe('plain notes', () => {
  it('read, edit and list as before, and never ask for a key', async () => {
    put('a', 'Buy *milk*\nand eggs');
    const before = copy(stored('a')) as Data;
    const t = tools();
    const note = await t.getNote({ id: 'a' });
    expect(note).toMatchObject({ body: 'Buy *milk*\nand eggs', title: 'Buy *milk*' });
    expect(await t.listNotes({})).toEqual([
      expect.objectContaining({ id: 'a', title: 'Buy *milk*' }),
    ]);
    expect(await t.searchNotes({ query: 'eggs' })).toEqual([expect.objectContaining({ id: 'a' })]);
    await t.addLines({ id: 'a', lines: ['- bread'] });
    expect(stored('a')['body']).toBe('Buy *milk*\nand eggs\n- bread');
    expect(stored('a')['title']).toBe(before['title']);
    expect(stored('a')['baseHash']).toBe(textHash('Buy *milk*\nand eggs'));
    expect(keyFor).not.toHaveBeenCalled();
  });

  it('split, merged and made from a template stay plain, with no key', async () => {
    put('a', 'One\n\nTwo');
    put('b', 'Three');
    put('tpl', 'Journal\n\n## Today', { kind: 'template', titleSource: 'user', title: 'Journal' });
    const t = tools();
    const split = await t.splitNote({ id: 'a', parts: ['One', 'Two'] });
    const merged = await t.mergeNotes({ ids: ['a', 'b'] });
    const used = await t.useTemplate({ id: 'tpl' });
    for (const id of [split.pieces[0].id, merged.id, used.note.id]) {
      expect(isSealed(stored(id)['body'])).toBe(false);
      expect(isSealed(stored(id)['title'])).toBe(false);
    }
    expect(keyFor).not.toHaveBeenCalled();
  });

  it('refuses to write plain text that would read as sealed', async () => {
    put('a', 'Hello');
    const t = tools();
    await expect(
      t.updateNote({ id: 'a', body: `${SEAL_SENTINEL}mg1.AAAA` }),
    ).rejects.toBeInstanceOf(ToolError);
    expect(stored('a')['body']).toBe('Hello');
  });
});

describe('sealed notes, with the key', () => {
  it('open for get, list and search, the key asked for once', async () => {
    putSealed('a', 'Dentist on Tuesday\nbring the *forms*');
    putSealed('b', 'Tuesday plans');
    put('c', 'See [[Dentist on Tuesday]]');
    const t = tools();
    const note = await t.getNote({ id: 'a' });
    expect(note).toMatchObject({
      title: 'Dentist on Tuesday',
      body: 'Dentist on Tuesday\nbring the *forms*',
    });
    expect(note.backlinks).toEqual([{ id: 'c', title: 'See [[Dentist on Tuesday]]' }]);
    const list = await t.listNotes({});
    expect(list.map((n) => ('title' in n ? n.title : n.sealed)).sort()).toEqual([
      'Dentist on Tuesday',
      'See [[Dentist on Tuesday]]',
      'Tuesday plans',
    ]);
    expect(listed(await t.searchNotes({ query: 'forms' })).map((n) => n.id)).toEqual(['a']);
    noCiphertext([note, list]);
    expect(keyFor).toHaveBeenCalledTimes(1);
    expect(keyFor).toHaveBeenCalledWith(UID);
  });

  it('an edit is sealed again under the same id and opens to the edited text', async () => {
    const text = 'Garden plan ✿ — naïve “quotes”\n\n- [ ] kale\n- [ ] chard';
    putSealed('a', text);
    const t = tools();
    await t.checkItem({ id: 'a', item: 'kale' });
    const body = stored('a')['body'];
    expect(isSealed(body)).toBe(true);
    expect(opened('a', 'body')).toBe(text.replace('- [ ] kale', '- [x] kale'));
    // The title follows the words, sealed as it was.
    expect(isSealed(stored('a')['title'])).toBe(true);
    expect(opened('a', 'title')).toBe('Garden plan ✿ — naïve “quotes”');
    // The hash History knows the text before by, of the plaintext.
    expect(stored('a')['baseHash']).toBe(textHash(text));
  });

  it('update_note keeps the body sealed, and a title written beside a sealed body is sealed too (review on #263)', async () => {
    putSealed('a', 'Old words', { titleSource: 'llm', title: 'Plain title' }, false);
    const t = tools();
    await t.updateNote({ id: 'a', body: 'New words', title: 'A new title' });
    expect(opened('a', 'body')).toBe('New words');
    // Never plainer than its body: a title from the body's first words
    // would otherwise say them in the clear.
    expect(isSealed(stored('a')['title'])).toBe(true);
    expect(opened('a', 'title')).toBe('A new title');
  });

  it("keeps Eric's text verbatim through a round trip", async () => {
    const eric = 'Line one  \n\ttabbed *bold* _it_ 🦔\r\nlast';
    putSealed('a', eric);
    const t = tools();
    await t.addLines({ id: 'a', lines: ['- an added line'] });
    const back = (await tools().getNote({ id: 'a' })).body as string;
    expect(back.startsWith(eric)).toBe(true);
    expect(back).toBe(opened('a', 'body'));
  });

  it('link_notes writes the line into a sealed body, sealed', async () => {
    putSealed('a', 'Notes on clay');
    put('k', '', { kind: 'concept', title: 'Kiln', titleSource: 'user' });
    await tools().linkNotes({ from: 'a', to: ['k'] });
    expect(opened('a', 'body')).toBe('Notes on clay\n\nSee also [[Kiln]]');
    expect(stored('a')['links']).toEqual(['k']);
  });

  it('split: each piece opened from the source and sealed under its own id', async () => {
    putSealed('a', 'First part\n\nSecond part');
    const t = tools();
    const { pieces } = await t.splitNote({ id: 'a', parts: ['First part', 'Second part'] });
    const piece = pieces[0].id;
    expect(isSealed(stored(piece)['body'])).toBe(true);
    expect(opened(piece, 'body')).toBe('Second part\n\nSplit from: [[First part]]');
    expect(opened(piece, 'title')).toBe('Second part');
    expect(opened('a', 'body')).toBe('First part\n\nSplit off: [[Second part]]');
    // Sealed under the piece's id: it does not open as the source's.
    expect(() => openText(key, aadFor(UID, 'a', 'body'), String(stored(piece)['body']))).toThrow();
  });

  it('merge: a sealed original makes the merged note sealed; originals stay as they were', async () => {
    putSealed('a', 'Sealed words');
    put('b', 'Plain words');
    const sealedBefore = stored('a')['body'];
    const { id } = await tools().mergeNotes({ ids: ['a', 'b'] });
    expect(opened(id, 'body')).toBe('Sealed words\n\nPlain words');
    expect(opened(id, 'title')).toBe('Sealed words');
    expect(stored('a')['body']).toBe(sealedBefore);
    expect(stored('a')).toMatchObject({ archived: true, mergedInto: id });
    expect(stored('b')['body']).toBe('Plain words');
  });

  it('refile into a project keeps the sealed text sealed, his words under Overview', async () => {
    putSealed('c-kiln', 'Our *kiln* project', {
      kind: 'concept',
      conceptType: 'other',
      title: 'Kiln',
      titleSource: 'user',
    });
    await tools().refile({ id: 'c-kiln', type: 'project' });
    const body = opened('c-kiln', 'body');
    expect(body).toContain('Our *kiln* project');
    expect(body).toContain('## Overview');
    expect(isSealed(stored('c-kiln')['body'])).toBe(true);
    expect(opened('c-kiln', 'title')).toBe('Kiln');
  });

  it('use_template: a sealed template starts a sealed note under the new id', async () => {
    putSealed('tpl', 'Journal\n\n## Today', {
      kind: 'template',
      titleSource: 'user',
      title: 'Journal',
    });
    const used = await tools().useTemplate({ id: 'tpl' });
    expect(used.note.body).toBe('Journal\n\n## Today');
    expect(opened(used.note.id, 'body')).toBe('Journal\n\n## Today');
  });

  it('writes no sealed title or line into what assistants changed', async () => {
    putSealed('a', 'Secret plans\n- [ ] the thing');
    await tools().checkItem({ id: 'a', item: 'the thing' });
    const [entry] = activity();
    expect(entry['summary']).toBe('Changed a sealed note');
    expect(entry['notes']).toEqual([{ id: 'a', title: 'Sealed note' }]);
    expect(JSON.stringify(entry)).not.toContain('Secret');
    expect(JSON.stringify(entry)).not.toContain('the thing');
  });
});

describe('suggest_changes', () => {
  it('checks against opened text and stores no sealed title in the clear', async () => {
    put('b', 'About clay');
    putSealed('k', '', { kind: 'concept', title: 'Kiln', titleSource: 'user' });
    const out = await tools().suggestChanges({
      proposals: [{ kind: 'link', from: 'b', to: ['k'], reason: 'Both about the kiln' }],
    });
    expect(out.stored).toHaveLength(1);
    const [proposal] = [...store.entries()]
      .filter(([p]) => p.startsWith(`users/${UID}/proposals/`))
      .map(([, d]) => d);
    expect(proposal['notes']).toEqual([
      { id: 'b', title: 'About clay' },
      { id: 'k', title: 'Sealed note' },
    ]);
    expect(JSON.stringify(proposal)).not.toContain('Kiln');
  });
});

describe('sealed notes, without the key', () => {
  beforeEach(() => {
    keyFor.mockImplementation(async () => {
      throw new NoteKeysUnconfigured('NOTE_KEYS_SERVICE is not set');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('get_note says the note is sealed: no ciphertext, never empty', async () => {
    putSealed('a', 'Private words');
    const err = await tools()
      .getNote({ id: 'a' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SealedNoteError);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as SealedNoteError).reason).toBe('no-key');
    expect((err as Error).message).toBe(
      'note a is sealed and cannot be opened here (its key is not available), so it is left as it is',
    );
    noCiphertext((err as Error).message);
  });

  it('a write to it fails and leaves it as it was', async () => {
    putSealed('a', 'Private words\n- [ ] x');
    const before = copy(stored('a')) as Data;
    const t = tools();
    for (const call of [
      () => t.updateNote({ id: 'a', body: 'Overwritten' }),
      () => t.addLines({ id: 'a', lines: ['more'] }),
      () => t.checkItem({ id: 'a', item: 'x' }),
      () => t.archiveNote({ id: 'a' }),
      () => t.splitNote({ id: 'a', parts: ['Private words', '- [ ] x'] }),
      () => t.refile({ id: 'a', addTags: ['t'] }),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(SealedNoteError);
    }
    expect(stored('a')).toEqual(before);
    expect(activity()).toEqual([]);
    // Asked once for the whole request, however many sealed values it met.
    expect(keyFor).toHaveBeenCalledTimes(1);
  });

  it('a merge or link that needs its text is refused, nothing written', async () => {
    putSealed('a', 'Private');
    put('b', 'Plain');
    const t = tools();
    await expect(t.mergeNotes({ ids: ['b', 'a'] })).rejects.toBeInstanceOf(SealedNoteError);
    await expect(t.linkNotes({ from: 'b', to: ['a'] })).rejects.toBeInstanceOf(SealedNoteError);
    expect(stored('b')['body']).toBe('Plain');
    expect(activity()).toEqual([]);
  });

  it('lists say sealed in place of its text; searches skip it and say how many', async () => {
    putSealed('a', 'Private words');
    put('b', 'Public words');
    const t = tools();
    const list = await t.listNotes({});
    const entry = list.find((n) => n.id === 'a')!;
    expect(entry).toMatchObject({
      id: 'a',
      kind: 'text',
      sealed: expect.stringContaining('Sealed'),
    });
    expect('title' in entry).toBe(false);
    expect('snippet' in entry).toBe(false);
    expect(await t.searchNotes({ query: 'words' })).toEqual({
      items: [expect.objectContaining({ id: 'b' })],
      sealedSkipped: 1,
      sealed: '1 sealed note could not be opened here, so its text was not searched.',
    });
    noCiphertext([list, await t.listConcepts({}), await t.getBacklinks({ id: 'b' })]);
  });

  it('a value that does not open (another key) reads as sealed too', async () => {
    put('a', seal('a', 'body', 'Other key', newDataKey()), { title: 'Plain' });
    keyFor.mockImplementation(async () => key);
    const err = await tools()
      .getNote({ id: 'a' })
      .catch((e: unknown) => e);
    expect((err as SealedNoteError).reason).toBe('did-not-open');
    // Its plain title still names it.
    const list = await tools().listNotes({});
    expect(list[0]).toMatchObject({ id: 'a', title: 'Plain', sealed: expect.any(String) });
    expect('snippet' in list[0]).toBe(false);
  });

  // Locked notes have no name (review of step 3b, closed in 3c, 2026-11-13).
  it('keeps a stored link to a note it cannot open when the links are worked out again', async () => {
    // Renamed since it was made, so its id is not the one its name makes.
    putSealed('c-old-name', 'Secret project', { kind: 'concept', titleSource: 'user' });
    put('b', 'See [[Secret project]]', { links: ['c-old-name'] });
    const t = tools();
    await t.updateNote({ id: 'b', body: 'See [[Secret project]] soon' });
    // Its name unread, the link also points where an unknown name does.
    expect(stored('b')['links']).toEqual(['c-secret-project', 'c-old-name']);
    await t.addLines({ id: 'b', lines: ['and [[Other]]'] });
    expect(stored('b')['links']).toEqual(['c-secret-project', 'c-other', 'c-old-name']);
    // A link that never pointed at it is not added.
    put('d', 'Nothing linked', { links: [] });
    await t.updateNote({ id: 'd', body: 'Still nothing' });
    expect(stored('d')['links']).toEqual([]);
  });

  it('makes no concept or recipe while a sealed one’s name cannot be read', async () => {
    store.set(`users/${UID}/settings/modules`, {
      projects: { enabled: true },
      kitchen: { enabled: true },
    });
    putSealed('c-x', 'Hidden name', { kind: 'concept', titleSource: 'user' });
    const t = tools();
    for (const call of [
      () => t.createConcept({ name: 'Anything' }),
      () => t.createRecipe({ name: 'Soup', ingredients: ['water'], method: ['boil'] }),
      () => t.importRecipe({ url: 'https://example.com/soup' }),
    ]) {
      await expect(call()).rejects.toThrow(/is refused for now: a sealed concept or recipe/);
    }
    expect([...store.keys()].filter((p) => p.startsWith(`users/${UID}/notes/`))).toEqual([
      `users/${UID}/notes/c-x`,
    ]);
    // A plain note, or a sealed one whose name is plain, refuses nothing.
    store.delete(`users/${UID}/notes/c-x`);
    putSealed('t1', 'A sealed text note', { kind: 'text' });
    put('c-y', seal('c-y', 'body', 'Body only sealed'), {
      kind: 'concept',
      title: 'Plain name',
      titleSource: 'user',
    });
    await expect(tools().createConcept({ name: 'Anything' })).resolves.toMatchObject({
      id: 'c-anything',
    });
    await expect(tools().createConcept({ name: 'Plain name' })).rejects.toThrow(
      /already a name in the garden/,
    );
  });
});

describe('organize outcomes (proposalAccepted)', () => {
  it('quote a sealed title as an activity entry does, when asked to', async () => {
    putSealed('a', 'Private plans');
    put('b', 'Plain note', { title: 'Plain note' });
    const t = tools();
    const linked = await t.linkNotes({ from: 'b', to: ['a'] }, { recorded: true });
    expect(linked.linked).toEqual([{ id: 'a', title: 'Sealed note' }]);
    put('c', 'Another', { title: 'Another' });
    const merged = await t.mergeNotes({ ids: ['c', 'a'] }, { recorded: true });
    expect(merged.title).toBe('Sealed note');
    // The tool's own answer, to the model, is opened.
    put('d', 'More');
    putSealed('e', 'Opened title');
    expect((await t.linkNotes({ from: 'd', to: ['e'] })).linked).toEqual([
      { id: 'e', title: 'Opened title' },
    ]);
  });
});
