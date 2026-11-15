import {
  type DataKey,
  SEALED_FIELDS,
  aadFor,
  fieldValue,
  isKeyedHash,
  isSealed,
  newDataKey,
  noteTextHash,
  openText,
  recordAadFor,
  sealText,
  textHash,
} from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteKeysUnconfigured } from '../note-keys/client';
import { type Store, copy, fakeDb } from '../testing/fake-firestore';
import { NoteCodec, SealedNoteError, sealFields, sealingIn } from './note-text';
import { NotesTools } from './tools';

// The gardener's switch (2026-11-15): with `sealNotes` on in
// settings/assistant, every tool that writes a note's text writes it
// sealed, a new note is born sealed, every hash it stores is keyed and
// every record about a note it writes is sealed or labelled. Off, every
// stored byte is as before and no key is asked for. Against the small
// in-memory Firestore, with a fake key source.

const UID = 'u1';
const T = Date.parse('2026-11-15T10:00:00Z');
const SETTINGS = `users/${UID}/settings/assistant`;

type Data = Record<string, unknown>;

let store: Store;
let key: DataKey;
let keyFor: ReturnType<typeof vi.fn<(uid: string) => Promise<DataKey>>>;

const notePath = (id: string) => `users/${UID}/notes/${id}`;
const stored = (id: string) => store.get(notePath(id))!;
const opened = (id: string, field: 'body' | 'title') =>
  openText(key, aadFor(UID, id, field), String(stored(id)[field]));
const entries = (prefix: string) =>
  [...store.entries()].filter(([p]) => p.startsWith(`users/${UID}/${prefix}/`));
const everything = () => JSON.stringify([...store.values()]);

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

const tools = () => new NotesTools(fakeDb(store), UID, () => T, undefined, undefined, keyFor);
const switchOn = (on = true) => store.set(SETTINGS, { sealNotes: on, updatedAt: T });

/** Every sealed field present on note `id` is stored sealed. */
function sealedThroughout(id: string) {
  const d = stored(id);
  for (const field of SEALED_FIELDS) {
    const v = fieldValue(d, field);
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) expect(isSealed(one), field).toBe(true);
  }
}

beforeEach(() => {
  store = new Map();
  store.set(`users/${UID}/settings/modules`, {
    projects: { enabled: true },
    reader: { enabled: true },
  });
  key = newDataKey();
  keyFor = vi.fn(async () => key);
});

describe('the switch off', () => {
  it('writes every byte as before and asks for no key, whether the setting is absent or off', async () => {
    for (const setting of [undefined, false]) {
      store.delete(SETTINGS);
      if (setting === false) switchOn(false);
      put('a', 'Buy milk');
      const t = tools();
      const { id } = await t.createNote({ body: 'Plumber on Tuesday' });
      await t.addLines({ id: 'a', lines: ['- eggs'] });
      expect(stored(id)).toMatchObject({ body: 'Plumber on Tuesday', title: 'Plumber on Tuesday' });
      expect(stored('a')).toMatchObject({
        body: 'Buy milk\n- eggs',
        baseHash: textHash('Buy milk'),
      });
      expect(everything()).toContain('Plumber on Tuesday');
      expect(keyFor).not.toHaveBeenCalled();
    }
  });

  it('reads the setting once a request, at most', async () => {
    put('a', 'One');
    put('b', 'Two');
    const sealing = vi.fn(async () => false);
    const t = new NotesTools(fakeDb(store), UID, () => T, undefined, undefined, keyFor, sealing);
    await t.listNotes({});
    await t.addLines({ id: 'a', lines: ['- more'] });
    await t.createNote({ body: 'Three' });
    expect(sealing).toHaveBeenCalledTimes(1);
    expect(keyFor).not.toHaveBeenCalled();
  });
});

describe('the switch on', () => {
  beforeEach(() => switchOn());

  it('create_note: born sealed, its hashes none, its record labelled; the words nowhere in the clear', async () => {
    const { id, title } = await tools().createNote({ body: 'Plumber on Tuesday\nbring the key' });
    // The answer to the model is the gardener's words, as ever.
    expect(title).toBe('Plumber on Tuesday');
    sealedThroughout(id);
    expect(opened(id, 'body')).toBe('Plumber on Tuesday\nbring the key');
    expect(opened(id, 'title')).toBe('Plumber on Tuesday');
    const [[, entry]] = entries('activity');
    expect(entry['notes']).toEqual([{ id, title: 'Sealed note', made: true }]);
    expect(everything()).not.toContain('Plumber');
  });

  it('an edit to a plain note seals the fields it writes, with a keyed baseHash the merge can find', async () => {
    put('a', 'Buy milk', { synonyms: ['groceries'] });
    await tools().addLines({ id: 'a', lines: ['- eggs'] });
    // Body and its words title, both written, both sealed.
    expect(opened('a', 'body')).toBe('Buy milk\n- eggs');
    expect(opened('a', 'title')).toBe('Buy milk');
    // The base is keyed (2026-11-14 rules), for the text it was written over.
    const baseHash = String(stored('a')['baseHash']);
    expect(isKeyedHash(baseHash)).toBe(true);
    expect(baseHash).toBe(noteTextHash('a', 'Buy milk', 'sealed', () => key));
    // A field the write did not touch keeps its form until written or migrated.
    expect(stored('a')['synonyms']).toEqual(['groceries']);
    // The summary names no sealed note's lines.
    const [[, entry]] = entries('activity');
    expect(entry['summary']).not.toContain('eggs');
    expect(entry['notes']).toEqual([{ id: 'a', title: 'Sealed note' }]);
    expect(everything()).not.toContain('eggs');
    expect(everything()).not.toContain(textHash('Buy milk'));
  });

  it('update_note seals a new title and other names, never plainer than the switch', async () => {
    put('c-kiln', '', {
      kind: 'concept',
      conceptType: 'other',
      title: 'Kiln',
      titleSource: 'user',
    });
    await tools().refile({ id: 'c-kiln', addSynonyms: ['Big oven'] });
    const names = stored('c-kiln')['synonyms'] as string[];
    expect(names.every(isSealed)).toBe(true);
    expect(openText(key, aadFor(UID, 'c-kiln', 'synonyms'), names[0])).toBe('Big oven');
    expect(everything()).not.toContain('Big oven');
  });

  it('split, merge, use_template and capture: every note made is born sealed', async () => {
    put('a', 'First part\n\nSecond part');
    put('b', 'Other words');
    put('tpl', 'Journal\n\n## Today', { kind: 'template', titleSource: 'user', title: 'Journal' });
    put('c-kiln', '## Overview\n\n## Ideas\n', {
      kind: 'concept',
      conceptType: 'project',
      title: 'Kiln',
      titleSource: 'user',
    });
    const t = tools();
    const { pieces } = await t.splitNote({ id: 'a', parts: ['First part', 'Second part'] });
    const merged = await t.mergeNotes({ ids: [pieces[0].id, 'b'] });
    const used = await t.useTemplate({ id: 'tpl' });
    await t.capture({ project: 'Kiln', kind: 'idea', text: 'Glaze test tiles' });
    const made = [...store.keys()]
      .filter((p) => p.startsWith(`users/${UID}/notes/`) && p.split('/').length === 4)
      .map((p) => p.split('/')[3])
      .filter((id) => !['a', 'b', 'tpl', 'c-kiln'].includes(id));
    expect(made).toEqual(expect.arrayContaining([pieces[0].id, merged.id, used.note.id]));
    expect(made.length).toBe(4);
    for (const id of made) sealedThroughout(id);
    // The sources' bodies each wrote are sealed too; a title the write
    // did not touch (the project's own name) keeps its form until then.
    expect(isSealed(stored('a')['body'])).toBe(true);
    expect(isSealed(stored('c-kiln')['body'])).toBe(true);
    expect(stored('c-kiln')['title']).toBe('Kiln');
    expect(everything()).not.toContain('Glaze test tiles');
    expect(everything()).not.toContain('Second part');
  });

  it('clip_feed_item: a clipping is a note like any other, born sealed', async () => {
    store.set(`users/${UID}/feedItems/i1`, {
      feedId: 'f1',
      title: 'Wood ash glazes',
      link: 'https://example.com/ash',
      content: 'Ash from the stove makes a runny celadon.',
      published: Timestamp.fromMillis(T - 1000),
    });
    store.set(`users/${UID}/feeds/f1`, { title: 'Pottery weekly' });
    const { id } = await tools().clipFeedItem({ id: 'i1' });
    sealedThroughout(id);
    expect(stored(id)['source']).toMatchObject({
      url: 'https://example.com/ash',
      feedItemId: 'i1',
    });
    const filed = entries('activity').map(([, e]) => e['summary']);
    expect(filed).toEqual(['Filed a sealed note from the Reader']);
  });

  it('suggest_changes stores a suggestion’s reason sealed, even about a plain note', async () => {
    put('a', 'Kiln notes');
    put('b', 'More kiln notes');
    await tools().suggestChanges({
      proposals: [{ kind: 'merge', ids: ['a', 'b'], reason: 'Both about the kiln' }],
    });
    const [[path, proposal]] = entries('proposals');
    const id = path.split('/').pop()!;
    expect(isSealed(proposal['reason'])).toBe(true);
    expect(
      openText(key, recordAadFor(UID, 'proposals', id, 'reason'), String(proposal['reason'])),
    ).toBe('Both about the kiln');
    expect(everything()).not.toContain('Both about the kiln');
  });

  it('with no key, writes nothing and says the note is sealed, never a plain write', async () => {
    keyFor.mockRejectedValue(new NoteKeysUnconfigured('APP_DOMAIN is not set'));
    put('a', 'Buy milk');
    const before = copy([...store.entries()]);
    const t = tools();
    await expect(t.createNote({ body: 'Plumber on Tuesday' })).rejects.toBeInstanceOf(
      SealedNoteError,
    );
    await expect(t.addLines({ id: 'a', lines: ['- eggs'] })).rejects.toBeInstanceOf(
      SealedNoteError,
    );
    expect(copy([...store.entries()])).toEqual(before);
  });

  it('a setting that cannot be read writes nothing', async () => {
    const sealing = vi.fn(async () => Promise.reject(new Error('unavailable')));
    put('a', 'Buy milk');
    const t = new NotesTools(fakeDb(store), UID, () => T, undefined, undefined, keyFor, sealing);
    await expect(t.addLines({ id: 'a', lines: ['- eggs'] })).rejects.toThrow('unavailable');
    expect(stored('a')['body']).toBe('Buy milk');
  });

  it('reads a sealed note back through get_note', async () => {
    const { id } = await tools().createNote({ body: 'Sealed from birth' });
    const note = await tools().getNote({ id });
    expect(note).toMatchObject({ body: 'Sealed from birth', title: 'Sealed from birth' });
  });
});

describe('turned off again', () => {
  it('unseals nothing: a sealed note stays sealed when written, a new note is plain', async () => {
    switchOn();
    const { id } = await tools().createNote({ body: 'Born sealed' });
    switchOn(false);
    const t = tools();
    await t.addLines({ id, lines: ['- still sealed'] });
    expect(opened(id, 'body')).toBe('Born sealed\n- still sealed');
    sealedThroughout(id);
    const plain = await t.createNote({ body: 'Born plain' });
    expect(stored(plain.id)['body']).toBe('Born plain');
  });
});

describe('sealFields itself', () => {
  it('seals every field of a write with the switch on, whatever forms it is given', async () => {
    switchOn();
    const codec = new NoteCodec(UID, keyFor, sealingIn(fakeDb(store), UID));
    const out = await sealFields(
      codec,
      'n1',
      { body: 'b', title: 't', synonyms: ['s'], source: { url: 'https://x.invalid', text: 'x' } },
      { ...(await new NoteCodec(UID, keyFor, async () => false).forms()) },
    );
    expect(isSealed(out['body'])).toBe(true);
    expect(isSealed(out['title'])).toBe(true);
    expect((out['synonyms'] as string[]).every(isSealed)).toBe(true);
    expect(out['source']).toMatchObject({ url: 'https://x.invalid' });
    expect(isSealed((out['source'] as Data)['text'])).toBe(true);
  });

  it('reads no setting for a write with no note text in it', async () => {
    const sealing = vi.fn(async () => true);
    const codec = new NoteCodec(UID, keyFor, sealing);
    const plain = { archived: true };
    expect(
      await sealFields(
        codec,
        'n1',
        plain,
        await new NoteCodec(UID, keyFor, async () => false).forms(),
      ),
    ).toEqual(plain);
    expect(sealing).not.toHaveBeenCalled();
    // A value sealed already, under another key, is refused rather than written.
    const other = sealText(newDataKey(), aadFor(UID, 'n1', 'body'), 'x');
    await expect(
      sealFields(codec, 'n1', { body: other }, await codec.forms(), new Set(['body'])),
    ).rejects.toBeInstanceOf(SealedNoteError);
  });
});
