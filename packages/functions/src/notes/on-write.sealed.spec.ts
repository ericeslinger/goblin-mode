import {
  type DataKey,
  SEAL_SENTINEL,
  aadFor,
  firstWordsTitle,
  isSealed,
  newDataKey,
  openText,
  sealText,
  textHash,
} from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteCodec } from '../mcp/note-text';
import { NoteKeysUnconfigured } from '../note-keys/client';
import { type Data, type Store, copy, fakeDb, snapAt } from '../testing/fake-firestore';
import { historyOnWrite, titleOnWrite } from './on-write';

// Note encryption step 3c (2026-11-13): noteHistory and noteTitle open a
// sealed note with one codec for the event and write back in its form;
// a note they cannot open is left as stored. Over the in-memory
// Firestore, with a fake key source.

const UID = 'u1';
const ID = 'n1';
const T = Date.parse('2026-11-13T10:00:00Z');
const NOTE = `users/${UID}/notes/${ID}`;

let store: Store;
let key: DataKey;
let keyFor: ReturnType<typeof vi.fn<(uid: string) => Promise<DataKey>>>;
type LogFn = (message: string, fields?: unknown) => void;
let log: {
  debug: ReturnType<typeof vi.fn<LogFn>>;
  info: ReturnType<typeof vi.fn<LogFn>>;
  warn: ReturnType<typeof vi.fn<LogFn>>;
};

const seal = (field: 'body' | 'title', text: string, k = key) =>
  sealText(k, aadFor(UID, ID, field), text);
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

/** A note, its body and title sealed under its own id. */
const sealedNote = (body: string, over: Data = {}) =>
  note(seal('body', body), { title: seal('title', body.split('\n')[0]), ...over });

/** A snapshot of `data` at the note's path, as an event's before or after. */
const snapOf = (data: Data | undefined) =>
  snapAt(data ? new Map([[NOTE, copy(data) as Data]]) : new Map(), NOTE);

/** The write `before` → `after`: the store holds `after`, then noteHistory runs. */
async function history(before: Data | undefined, after: Data | undefined, eventId = 'e1') {
  if (after) store.set(NOTE, copy(after) as Data);
  else store.delete(NOTE);
  return historyOnWrite(
    fakeDb(store),
    new NoteCodec(UID, keyFor),
    UID,
    ID,
    eventId,
    snapOf(before),
    snapOf(after),
    T,
    log,
  );
}

const under = (sub: string) =>
  [...store.entries()].filter(([p]) => p.startsWith(`${NOTE}/${sub}/`)).map(([p, d]) => ({ p, d }));

beforeEach(() => {
  store = new Map();
  key = newDataKey();
  keyFor = vi.fn(async () => key);
  log = { debug: vi.fn<LogFn>(), info: vi.fn<LogFn>(), warn: vi.fn<LogFn>() };
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('noteHistory, plain notes', () => {
  it('keeps, remembers and merges as before, and never asks for a key', async () => {
    const base = 'one\ntwo';
    const before = note(`${base}\nthree`, { deviceId: 'phone', baseHash: textHash(base) });
    const after = note(`zero\n${base}`, { deviceId: 'laptop', baseHash: textHash(base) });
    store.set(`${NOTE}/replaced/${textHash(base)}`, {
      body: base,
      writtenAt: Timestamp.fromMillis(T - 120_000),
    });
    expect(await history(before, after)).toEqual({ kept: 'device', merged: 'merged' });
    const [kept] = under('history');
    expect(kept.d).toMatchObject({ body: 'one\ntwo\nthree', title: 'one', reason: 'device' });
    expect(store.get(`${NOTE}/replaced/${textHash('one\ntwo\nthree')}`)?.['body']).toBe(
      'one\ntwo\nthree',
    );
    expect(store.get(NOTE)).toMatchObject({
      body: 'zero\none\ntwo\nthree',
      title: firstWordsTitle('zero\none\ntwo\nthree'),
      baseHash: textHash(`zero\n${base}`),
      deviceId: 'merge',
    });
    expect(keyFor).not.toHaveBeenCalled();
  });
});

describe('noteHistory, a sealed note with its key', () => {
  it('keeps the stored sealed strings as they are, which open with the note’s aad', async () => {
    const before = sealedNote('Dentist Tuesday\nbring forms');
    const after = sealedNote('Dentist Tuesday\nbring forms\nand the card', { deviceId: 'laptop' });
    expect((await history(before, after)).kept).toBe('device');
    const [kept] = under('history');
    expect(kept.d['body']).toBe(before['body']);
    expect(kept.d['title']).toBe(before['title']);
    expect(open('body', kept.d['body'])).toBe('Dentist Tuesday\nbring forms');
    expect(open('title', kept.d['title'])).toBe('Dentist Tuesday');
    expect(keyFor).toHaveBeenCalledTimes(1);
  });

  it('keeps no sealed note’s replaced text in the clear: the stored form, by its plaintext hash', async () => {
    const text = 'Private plans\nfor Sunday';
    const before = sealedNote(text);
    await history(before, sealedNote(`${text}\nmore`));
    const replaced = under('replaced');
    expect(replaced).toHaveLength(1);
    expect(replaced[0].p).toBe(`${NOTE}/replaced/${textHash(text)}`);
    expect(replaced[0].d['body']).toBe(before['body']);
    expect(JSON.stringify(replaced[0].d)).not.toContain('Private');
    expect(open('body', replaced[0].d['body'])).toBe(text);
  });

  it('merges sealed text to the right plaintext, sealed again under the note’s id', async () => {
    const base = 'one\ntwo';
    store.set(`${NOTE}/replaced/${textHash(base)}`, {
      body: seal('body', base),
      writtenAt: Timestamp.fromMillis(T - 120_000),
    });
    const before = sealedNote(`${base}\nthree`, { deviceId: 'phone', baseHash: textHash(base) });
    const after = sealedNote(`zero\n${base}`, { deviceId: 'laptop', baseHash: textHash(base) });
    expect((await history(before, after)).merged).toBe('merged');
    const now = store.get(NOTE)!;
    expect(isSealed(now['body'])).toBe(true);
    expect(isSealed(now['title'])).toBe(true);
    expect(open('body', now['body'])).toBe('zero\none\ntwo\nthree');
    expect(open('title', now['title'])).toBe(firstWordsTitle('zero\none\ntwo\nthree'));
    expect(now['baseHash']).toBe(textHash(`zero\n${base}`));
    expect(JSON.stringify(now)).not.toContain('three');
  });

  it('a plain note stays plain through a merge, with no key', async () => {
    const base = 'a\nb';
    store.set(`${NOTE}/replaced/${textHash(base)}`, {
      body: base,
      writtenAt: Timestamp.fromMillis(T - 120_000),
    });
    await history(
      note(`${base}\nc`, { baseHash: textHash(base) }),
      note(`z\n${base}`, { deviceId: 'laptop', baseHash: textHash(base) }),
    );
    expect(store.get(NOTE)!['body']).toBe('z\na\nb\nc');
    expect(keyFor).not.toHaveBeenCalled();
  });
});

describe('noteHistory, a sealed note it cannot open', () => {
  beforeEach(() => {
    keyFor.mockImplementation(async () => {
      throw new NoteKeysUnconfigured('NOTE_KEYS_SERVICE is not set');
    });
  });

  it('leaves the note byte for byte as stored, merges nothing, and keeps what it replaced as stored', async () => {
    const base = 'one\ntwo';
    const before = sealedNote(`${base}\nthree`, { deviceId: 'phone', baseHash: textHash(base) });
    const after = sealedNote(`zero\n${base}`, { deviceId: 'laptop', baseHash: textHash(base) });
    const out = await history(before, after);
    expect(out).toEqual({ kept: 'device', merged: 'none', sealed: true });
    expect(store.get(NOTE)).toEqual(after);
    expect(under('replaced')).toEqual([]);
    const [kept] = under('history');
    expect(kept.d['body']).toBe(before['body']);
    expect(kept.d['title']).toBe(before['title']);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('noteHistory left a sealed'), {
      noteId: ID,
      reason: 'no-key',
    });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(SEAL_SENTINEL);
  });

  it('a write by the same device keeps nothing, writes nothing, and does not throw', async () => {
    const before = sealedNote('Private');
    const after = sealedNote('Private, more');
    await expect(history(before, after)).resolves.toMatchObject({ sealed: true, kept: null });
    expect(store.get(NOTE)).toEqual(after);
    expect(under('history')).toEqual([]);
  });

  it('a value that does not open with this key is left as stored too', async () => {
    keyFor.mockImplementation(async () => key);
    const other = newDataKey();
    const before = note(seal('body', 'Old', other), { title: seal('title', 'Old', other) });
    const after = note(seal('body', 'New', other), {
      title: seal('title', 'New', other),
      deviceId: 'laptop',
      baseHash: textHash('older'),
    });
    expect(await history(before, after)).toMatchObject({ sealed: true });
    expect(store.get(NOTE)).toEqual(after);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), {
      noteId: ID,
      reason: 'did-not-open',
    });
  });

  it('a write that leaves the stored body as it was opens nothing and asks for no key', async () => {
    const n = sealedNote('Private');
    await history(n, { ...n, settledAt: Timestamp.fromMillis(T) });
    expect(keyFor).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('noteTitle', () => {
  const settled = { settledAt: Timestamp.fromMillis(T) };
  const body = 'met the plumber about the leak under the kitchen sink today';

  it('gives the model the opened body and writes its title sealed', async () => {
    const after = sealedNote(body, settled);
    store.set(NOTE, copy(after) as Data);
    const titler = vi.fn(async () => 'Plumber visit');
    const out = await titleOnWrite(
      fakeDb(store),
      new NoteCodec(UID, keyFor),
      titler,
      UID,
      ID,
      snapOf(sealedNote(body)),
      snapOf(after),
      log,
    );
    expect(out).toBe('written');
    expect(titler).toHaveBeenCalledWith(body);
    const now = store.get(NOTE)!;
    expect(isSealed(now['title'])).toBe(true);
    expect(open('title', now['title'])).toBe('Plumber visit');
    expect(now['titleSource']).toBe('llm');
    expect(now['body']).toBe(after['body']);
  });

  it('writes a plain note’s title plain, with no key', async () => {
    const after = note(body, settled);
    store.set(NOTE, copy(after) as Data);
    const out = await titleOnWrite(
      fakeDb(store),
      new NoteCodec(UID, keyFor),
      async () => 'Plumber visit',
      UID,
      ID,
      snapOf(note(body)),
      snapOf(after),
      log,
    );
    expect(out).toBe('written');
    expect(store.get(NOTE)!['title']).toBe('Plumber visit');
    expect(keyFor).not.toHaveBeenCalled();
  });

  it('a note it cannot open gets no model title and is not written', async () => {
    keyFor.mockImplementation(async () => {
      throw new NoteKeysUnconfigured('NOTE_KEYS_SERVICE is not set');
    });
    const after = sealedNote(body, settled);
    store.set(NOTE, copy(after) as Data);
    const titler = vi.fn(async () => 'Plumber visit');
    const out = await titleOnWrite(
      fakeDb(store),
      new NoteCodec(UID, keyFor),
      titler,
      UID,
      ID,
      snapOf(sealedNote(body)),
      snapOf(after),
      log,
    );
    expect(out).toBe('sealed');
    expect(titler).not.toHaveBeenCalled();
    expect(store.get(NOTE)).toEqual(after);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
