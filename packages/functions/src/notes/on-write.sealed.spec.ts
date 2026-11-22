import {
  type DataKey,
  SEAL_SENTINEL,
  aadFor,
  firstWordsTitle,
  isKeyedHash,
  isSealed,
  newDataKey,
  noteTextHash,
  noteTitleHash,
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
// sealed note with one codec for the event and write back sealed (in
// its own form until 2026-11-15, always sealed since); a note they
// cannot open is left as stored. Since 2026-11-15 noteHistory also
// seals a note a write left plain (seal-plain.ts). Over the in-memory
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

/** A sealed note's body hash (2026-11-14), under this test's key. */
const keyed = (text: string) => noteTextHash(ID, text, 'sealed', () => key)!;

describe('noteHistory, plain notes (still read, written sealed)', () => {
  it('keeps, remembers and merges a plain write, every copy sealed, its hashes keyed', async () => {
    const base = 'one\ntwo';
    const before = note(`${base}\nthree`, { deviceId: 'phone', baseHash: textHash(base) });
    const after = note(`zero\n${base}`, { deviceId: 'laptop', baseHash: textHash(base) });
    // A plain replaced text from before 2026-11-15, still read.
    store.set(`${NOTE}/replaced/${textHash(base)}`, {
      body: base,
      writtenAt: Timestamp.fromMillis(T - 120_000),
    });
    // The merge writes the note sealed throughout: nothing left to seal.
    expect(await history(before, after)).toEqual({
      kept: 'device',
      merged: 'merged',
      plain: 'already',
    });
    const [kept] = under('history');
    expect(kept.d).toMatchObject({ reason: 'device' });
    expect(open('body', kept.d['body'])).toBe('one\ntwo\nthree');
    expect(open('title', kept.d['title'])).toBe('one');
    expect(open('body', store.get(`${NOTE}/replaced/${keyed('one\ntwo\nthree')}`)?.['body'])).toBe(
      'one\ntwo\nthree',
    );
    const now = store.get(NOTE)!;
    expect(open('body', now['body'])).toBe('zero\none\ntwo\nthree');
    expect(open('title', now['title'])).toBe(firstWordsTitle('zero\none\ntwo\nthree'));
    expect(now).toMatchObject({ baseHash: keyed(`zero\n${base}`), deviceId: 'merge' });
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

  it('keeps no sealed note’s replaced text in the clear: the stored form, under a keyed hash', async () => {
    const text = 'Private plans\nfor Sunday';
    const before = sealedNote(text);
    await history(before, sealedNote(`${text}\nmore`));
    const replaced = under('replaced');
    expect(replaced).toHaveLength(1);
    // Keyed since 2026-11-14: no plain hash of the text in its id.
    expect(replaced[0].p).toBe(`${NOTE}/replaced/${keyed(text)}`);
    expect(replaced[0].p).not.toContain(textHash(text));
    expect(replaced[0].d['body']).toBe(before['body']);
    expect(JSON.stringify(replaced[0].d)).not.toContain('Private');
    expect(open('body', replaced[0].d['body'])).toBe(text);
  });

  it('merges sealed text to the right plaintext, sealed again under the note’s id', async () => {
    const base = 'one\ntwo';
    store.set(`${NOTE}/replaced/${keyed(base)}`, {
      body: seal('body', base),
      writtenAt: Timestamp.fromMillis(T - 120_000),
    });
    const before = sealedNote(`${base}\nthree`, { deviceId: 'phone', baseHash: keyed(base) });
    const after = sealedNote(`zero\n${base}`, { deviceId: 'laptop', baseHash: keyed(base) });
    expect((await history(before, after)).merged).toBe('merged');
    const now = store.get(NOTE)!;
    expect(isSealed(now['body'])).toBe(true);
    expect(isSealed(now['title'])).toBe(true);
    expect(open('body', now['body'])).toBe('zero\none\ntwo\nthree');
    expect(open('title', now['title'])).toBe(firstWordsTitle('zero\none\ntwo\nthree'));
    expect(now['baseHash']).toBe(keyed(`zero\n${base}`));
    expect(JSON.stringify(now)).not.toContain('three');
    // No plain hash of any of its texts is stored anywhere.
    const all = JSON.stringify([...store.entries()]);
    for (const t of [base, `${base}\nthree`, `zero\n${base}`, 'zero\none\ntwo\nthree']) {
      expect(all).not.toContain(textHash(t));
    }
  });

  it('a plain baseHash from before keyed hashes still finds its plain-id replaced text', async () => {
    // Readers before writers: a sealed note with hashes of the old kind.
    const base = 'one\ntwo';
    store.set(`${NOTE}/replaced/${textHash(base)}`, {
      body: seal('body', base),
      writtenAt: Timestamp.fromMillis(T - 120_000),
    });
    const before = sealedNote(`${base}\nthree`, { deviceId: 'phone', baseHash: textHash(base) });
    const after = sealedNote(`zero\n${base}`, { deviceId: 'laptop', baseHash: textHash(base) });
    expect((await history(before, after)).merged).toBe('merged');
    const now = store.get(NOTE)!;
    expect(open('body', now['body'])).toBe('zero\none\ntwo\nthree');
    // What the merge writes is keyed: the note is sealed.
    expect(now['baseHash']).toBe(keyed(`zero\n${base}`));
  });

  it('a keyed hash is never taken for a plain one, nor bound to another note', async () => {
    // after names its base by a hash of the text before, but made for
    // another note: not "built on it", so both writes' lines are kept.
    const before = sealedNote('a\nb\nx', { deviceId: 'phone' });
    const after = sealedNote('a\nb\nc', {
      deviceId: 'laptop',
      baseHash: noteTextHash('n2', 'a\nb\nx', 'sealed', () => key),
    });
    expect((await history(before, after)).merged).toBe('kept-both');
    // Made for this note, it says the writer saw the text: nothing to merge.
    const own = sealedNote('a\nb\nc', { deviceId: 'laptop', baseHash: keyed('a\nb\nx') });
    expect((await history(before, own)).merged).toBe('clean');
    // A plain hash on a sealed note is checked as a plain one: it matches.
    const old = sealedNote('a\nb\nd', { deviceId: 'tablet', baseHash: textHash('a\nb\nx') });
    expect((await history(before, old)).merged).toBe('clean');
  });

  it('a plain note is merged and written sealed', async () => {
    const base = 'a\nb';
    store.set(`${NOTE}/replaced/${textHash(base)}`, {
      body: base,
      writtenAt: Timestamp.fromMillis(T - 120_000),
    });
    await history(
      note(`${base}\nc`, { baseHash: textHash(base) }),
      note(`z\n${base}`, { deviceId: 'laptop', baseHash: textHash(base) }),
    );
    expect(open('body', store.get(NOTE)!['body'])).toBe('z\na\nb\nc');
  });
});

describe('noteHistory, a keyed base and no key', () => {
  it('a plain note with a keyed baseHash is left as stored, unmerged, not guessed at', async () => {
    keyFor.mockImplementation(async () => {
      throw new NoteKeysUnconfigured('no note keys here');
    });
    const before = note('one\ntwo\nthree', { deviceId: 'phone' });
    const after = note('zero\none\ntwo', { deviceId: 'laptop', baseHash: keyed('one\ntwo') });
    const out = await history(before, after);
    expect(out).toMatchObject({ merged: 'none', sealed: true });
    expect(store.get(NOTE)).toEqual(after);
  });
});

describe('noteHistory, a sealed note it cannot open', () => {
  beforeEach(() => {
    keyFor.mockImplementation(async () => {
      throw new NoteKeysUnconfigured('no note keys here');
    });
  });

  it('leaves the note byte for byte as stored, merges nothing, and keeps what it replaced as stored', async () => {
    const base = 'one\ntwo';
    const before = sealedNote(`${base}\nthree`, { deviceId: 'phone', baseHash: keyed(base) });
    const after = sealedNote(`zero\n${base}`, { deviceId: 'laptop', baseHash: keyed(base) });
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

  it('keeps a keyed hash of what the title was made from, and asks nothing of the same text again (2026-11-22)', async () => {
    const titler = vi.fn(async () => 'Plumber visit');
    const settle = async (before: Data, after: Data) => {
      store.set(NOTE, copy(after) as Data);
      return titleOnWrite(
        fakeDb(store),
        new NoteCodec(UID, keyFor),
        titler,
        UID,
        ID,
        snapOf(before),
        snapOf(after),
        log,
      );
    };
    expect(await settle(sealedNote(body), sealedNote(body, settled))).toBe('written');
    const titled = store.get(NOTE)!;
    const hash = titled['titleHash'];
    expect(isKeyedHash(hash)).toBe(true);
    expect(hash).toBe(noteTitleHash(ID, 'Plumber visit', body, () => key));
    // Neither the words nor a plain hash of them.
    expect(JSON.stringify(titled)).not.toContain('plumber');
    expect(JSON.stringify(titled)).not.toContain(textHash(body));
    // Settled again with the text as it was (a line typed and taken out).
    const again = { ...titled, settledAt: Timestamp.fromMillis(T + 60_000) };
    expect(await settle(titled, again)).toBe('same');
    expect(titler).toHaveBeenCalledTimes(1);
    // Settled with the text changed: asked again.
    const changed = {
      ...again,
      body: seal('body', `${body}\nand the tap`),
      settledAt: Timestamp.fromMillis(T + 120_000),
    };
    expect(await settle(again, changed)).toBe('written');
    expect(titler).toHaveBeenCalledTimes(2);
    expect(titler).toHaveBeenLastCalledWith(`${body}\nand the tap`);
    expect(store.get(NOTE)!['titleHash']).not.toBe(hash);
  });

  it('a note it cannot open gets no model title and is not written', async () => {
    keyFor.mockImplementation(async () => {
      throw new NoteKeysUnconfigured('no note keys here');
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

describe('the write that seals a plain note (2026-11-15)', () => {
  it('History keeps the plain version sealed, the merge finds its base', async () => {
    // The app writes over the plain text it was showing: the body sealed
    // now, its base keyed, for the text it was written over.
    const base = 'one\ntwo';
    const before = note(base, { deviceId: 'phone' });
    const after = note(seal('body', `${base}\nthree`), {
      title: seal('title', 'one'),
      deviceId: 'laptop',
      baseHash: keyed(base),
    });
    expect(await history(before, after)).toEqual({ kept: 'device', merged: 'clean' });
    // The version kept is the plain one, sealed as it is kept.
    const [kept] = under('history');
    expect(isSealed(kept.d['body'])).toBe(true);
    expect(open('body', kept.d['body'])).toBe(base);
    expect(open('title', kept.d['title'])).toBe('one');
    // The text it replaced, sealed, under a keyed id.
    const [replaced] = under('replaced');
    expect(replaced.p.endsWith(`/${keyed(base)}`)).toBe(true);
    expect(open('body', replaced.d['body'])).toBe(base);
    expect(JSON.stringify([...store.values()])).not.toContain(textHash(base));
    // Nothing but the note's own fields hold its words in the clear.
    for (const { d } of [...under('history'), ...under('replaced')]) {
      expect(JSON.stringify(d)).not.toContain('one\ntwo');
    }
  });

  it('a write over newer plain text merges across the turn, written sealed with a keyed base', async () => {
    const base = 'one\ntwo';
    // The phone wrote plain, before sealing, over the base.
    store.set(`${NOTE}/replaced/${textHash(base)}`, {
      body: base,
      writtenAt: Timestamp.fromMillis(T - 120_000),
    });
    const before = note(`${base}\nthree`, { deviceId: 'phone', baseHash: textHash(base) });
    // The laptop had not seen it: sealed, keyed base.
    const after = note(seal('body', `zero\n${base}`), {
      title: seal('title', 'zero'),
      deviceId: 'laptop',
      baseHash: keyed(base),
    });
    expect((await history(before, after)).merged).toBe('merged');
    const now = store.get(NOTE)!;
    expect(open('body', now['body'])).toBe('zero\none\ntwo\nthree');
    expect(isSealed(now['title'])).toBe(true);
    expect(isKeyedHash(now['baseHash'])).toBe(true);
    expect(now['baseHash']).toBe(keyed(`zero\n${base}`));
  });

  it('noteTitle writes a plain note’s title sealed', async () => {
    const settled = { settledAt: Timestamp.fromMillis(T) };
    const body = 'met the plumber about the leak under the kitchen sink today';
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
    expect(open('title', store.get(NOTE)!['title'])).toBe('Plumber visit');
  });

  it('with no key, keeps a plain version as stored rather than lose it, and merges nothing', async () => {
    keyFor.mockRejectedValue(new NoteKeysUnconfigured('no keys here'));
    const before = note('one\ntwo', { deviceId: 'phone' });
    const after = note('one\ntwo\nthree', { deviceId: 'laptop' });
    await history(before, after);
    const [kept] = under('history');
    expect(kept.d['body']).toBe('one\ntwo');
    expect(store.get(NOTE)!['body']).toBe('one\ntwo\nthree');
  });
});

describe('a note written plain is sealed by noteHistory (2026-11-15)', () => {
  /** What an out-of-date app writes: the whole note plain, over the sealed note it had. */
  const oldApp = (body: string, over: Data = {}) =>
    note(body, { deviceId: 'old-phone', updatedAt: Timestamp.fromMillis(T - 1000), ...over });

  it('seals every plain field and keys its base to the text it replaced, nothing else changed', async () => {
    const before = sealedNote('Garden\nplant beans', { baseHash: keyed('Garden') });
    const after = oldApp('Garden\nplant beans\nand peas', {
      instructions: 'Newest first',
      synonyms: ['Veg patch'],
      baseHash: textHash('Garden\nplant beans'),
    });
    expect(await history(before, after)).toMatchObject({ plain: 'sealed' });
    const now = store.get(NOTE)!;
    expect(open('body', now['body'])).toBe('Garden\nplant beans\nand peas');
    expect(open('title', now['title'])).toBe('Garden');
    expect(openText(key, aadFor(UID, ID, 'instructions'), String(now['instructions']))).toBe(
      'Newest first',
    );
    expect((now['synonyms'] as string[]).every(isSealed)).toBe(true);
    // The base is keyed to the text it named, the one this write replaced.
    expect(now['baseHash']).toBe(keyed('Garden\nplant beans'));
    // A write of form alone: the writer's stamp is as it was.
    for (const f of ['updatedAt', 'updatedBy', 'deviceId', 'links', 'tags', 'kind'])
      expect(now[f]).toEqual(after[f]);
    expect(JSON.stringify([...store.values()])).not.toMatch(/peas|Veg patch|Newest first/);
    expect(log.info).toHaveBeenCalledWith('noteHistory sealed a note written plain', {
      noteId: ID,
      baseUnkept: false,
    });
  });

  it('the write it makes fires noteHistory again, which keeps, merges and seals nothing: no loop', async () => {
    const before = sealedNote('Garden\nplant beans');
    const after = oldApp('Garden\nplant beans\nand peas', {
      baseHash: textHash('Garden\nplant beans'),
    });
    await history(before, after);
    const sealed = copy(store.get(NOTE)!) as Data;
    const counts = () => [under('history').length, under('replaced').length];
    const was = counts();
    // The seal's own event: the plain write before, the sealed one after.
    const again = await history(after, sealed, 'e2');
    expect(again).toEqual({ kept: null, merged: 'clean' });
    expect(counts()).toEqual(was);
    expect(store.get(NOTE)).toEqual(sealed);
  });

  it('costs nothing for a sealed write: no key asked, nothing read', async () => {
    const n = sealedNote('Private', { baseHash: keyed('Private before') });
    const out = await history(n, { ...n, settledAt: Timestamp.fromMillis(T) });
    expect(out).toEqual({ kept: null, merged: 'none' });
    expect(keyFor).not.toHaveBeenCalled();
  });

  it('seals a plain field an old app wrote beside a sealed body, the body untouched', async () => {
    const before = sealedNote('Kiln log');
    const after = { ...before, instructions: 'One line each', deviceId: 'old-phone' };
    expect(await history(before, after)).toEqual({ kept: null, merged: 'none', plain: 'sealed' });
    const now = store.get(NOTE)!;
    expect(now['body']).toBe(before['body']);
    expect(isSealed(now['instructions'])).toBe(true);
  });

  it('with no key: left as stored, logged without text, tried again at its next write', async () => {
    keyFor.mockRejectedValue(new NoteKeysUnconfigured('no keys here'));
    const before = note('Garden', { deviceId: 'phone' });
    const after = oldApp('Garden\nbeans');
    expect(await history(before, after)).toMatchObject({ plain: 'left' });
    expect(store.get(NOTE)).toEqual(after);
    expect(log.warn).toHaveBeenCalledWith(
      'noteHistory left a note written plain as stored; its next write tries again',
      { noteId: ID, reason: 'no-key' },
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('beans');
    // The key back, the next write seals it.
    keyFor.mockResolvedValue(key);
    const next = oldApp('Garden\nbeans\npeas');
    expect(await history(after, next, 'e2')).toMatchObject({ plain: 'sealed' });
    expect(open('body', store.get(NOTE)!['body'])).toBe('Garden\nbeans\npeas');
  });

  it('leaves a recipe import just asked for to the import’s own write', async () => {
    const after = oldApp('', {
      kind: 'recipe',
      importState: 'requested',
      updatedAt: Timestamp.fromMillis(T - 60_000),
      source: { url: 'https://example.com/soup' },
    });
    expect(await history(undefined, after)).toMatchObject({ plain: 'busy' });
    expect(store.get(NOTE)).toEqual(after);
  });

  it('keys a plain base it cannot find to nothing, so nothing guessable is left', async () => {
    const before = sealedNote('Now');
    const after = oldApp('Now\nmore', { baseHash: textHash('kept nowhere') });
    await history(before, after);
    const now = store.get(NOTE)!;
    expect(isKeyedHash(now['baseHash'])).toBe(true);
    expect(JSON.stringify(now)).not.toContain(textHash('kept nowhere'));
  });
});
