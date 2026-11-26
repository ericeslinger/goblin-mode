import {
  type DataKey,
  RESTORE_SUFFIX,
  SEND_ASK_MAX,
  type SealedField,
  aadFor,
  isKeyedHash,
  isSealed,
  newDataKey,
  noteTextHash,
  openSealedText,
  sealText,
  textHash,
} from '@mossgoblin/schema';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { fakeFirebase } from '../testing/fakes';
import { NOW, ONLINE } from '../platform/platform';
import { NoteKeyService } from './note-key.service';
import { KeyWaitNotice } from './key-wait-notice';
import { TEST_NOTE_KEY, openedWrite } from '../testing/sealed';
import {
  type BatchWrite,
  NOTES_API,
  type NotesApi,
  NotesService,
  OpenedTexts,
  SEALED_TITLE,
  toRecord,
  PENDING_CONCEPTS_KEY,
  PENDING_INSTRUCTIONS_KEY,
  PENDING_MOODS_KEY,
  PENDING_NAMES_KEY,
  PENDING_SAVES_KEY,
  SHARED_IMPORT_WAITING,
} from './notes.service';

/**
 * What `removeField` gives here: not a string, as Firestore's deleteField
 * is not, so the seam never takes it for note text.
 */
const REMOVED = Object.freeze({ removed: true });

/** What each recorded write went out as, sealed, by the opened copy specs read. */
const RAW = new WeakMap<object, Record<string, unknown>>();
/** A write's data as it went out: its sealed values as they were sent. */
const asSent = <C extends unknown[]>(call: C): C =>
  call.map((v, i) => (i === 2 && v && typeof v === 'object' ? (RAW.get(v) ?? v) : v)) as C;
/** A body hash as every save now writes it: keyed with the device's key (2026-11-15). */
const keyedHash = (id: string, text: string, key: DataKey = TEST_NOTE_KEY) =>
  noteTextHash(id, text, 'sealed', () => key);

/** The device's clock in these specs. */
const CLOCK = Date.parse('2026-11-09T12:00:00Z');

/**
 * `reload` keeps this device's storage, as a page loaded again does.
 * The device has its note key unless `key` says otherwise (always
 * sealed, 2026-11-15): every note text it writes is sealed. `api.set`
 * and `api.createIfAbsent` record each write with its sealed fields
 * opened with the key it was sealed with, so specs read the words; the
 * writes as they went out, sealed, are in `sent`.
 */
function setup(opts: { reload?: boolean; key?: DataKey | undefined } = {}) {
  const reload = opts.reload ?? false;
  // An explicit `key: undefined` is a device with no key, not the default.
  const startKey = 'key' in opts ? opts.key : TEST_NOTE_KEY;
  if (reload) TestBed.resetTestingModule();
  else localStorage.clear();
  const user = signal<User | null | undefined>(undefined);
  let push: Parameters<NotesApi['listen']>[2] = () => undefined;
  /** What a batch's commit gives: the server's answer, or none yet (offline). */
  let commitResult = (): Promise<void> => Promise.resolve();
  const api = {
    listen: vi.fn((_db, _path, next) => {
      push = next;
      return vi.fn();
    }),
    set: vi.fn((_db: unknown, _path: string, _data: Record<string, unknown>, _merge: boolean) =>
      Promise.resolve(),
    ),
    createIfAbsent: vi.fn((_db: unknown, _path: string, _data: Record<string, unknown>) =>
      Promise.resolve(true),
    ),
    remove: vi.fn((_db: unknown, _path: string) => Promise.resolve()),
    commit: vi.fn((_db: unknown, _writes: BatchWrite[]) => commitResult()),
    synced: vi.fn((_db: unknown) => Promise.resolve()),
    serverTime: () => 'SERVER_TIME',
    timestamp: (ms: number) => ({ ms }),
    removeField: () => REMOVED,
  } satisfies NotesApi;
  const online = signal(true);
  /** The gardener's note key as NoteKeyService holds it (step 3a). */
  const key = signal<DataKey | undefined>(startKey);
  /** Every note write as it went out, sealed. */
  const sent: { path: string; data: Record<string, unknown> }[] = [];
  const opened = (path: string, data: Record<string, unknown>) => {
    sent.push({ path, data });
    const k = key();
    const seenData = k ? openedWrite(path, data, k) : data;
    if (seenData !== data) RAW.set(seenData, data);
    return seenData;
  };
  const seen: NotesApi = {
    ...api,
    set: (db, path, data, merge) => api.set(db, path, opened(path, data), merge),
    createIfAbsent: (db, path, data) => api.createIfAbsent(db, path, opened(path, data)),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: { user } },
      { provide: NoteKeyService, useValue: { key, unconfigured: signal(false) } },
      { provide: NOTES_API, useValue: seen },
      { provide: ONLINE, useValue: () => online() },
      { provide: NOW, useValue: () => CLOCK },
    ],
  });
  const notes = TestBed.inject(NotesService);
  const signIn = (uid: string) => {
    user.set({ uid } as User);
    TestBed.tick();
  };
  return {
    notes,
    api,
    signIn,
    /** A snapshot; from the server unless `fromCache`. */
    push: (docs: Parameters<typeof push>[0], { fromCache = false } = {}) => push(docs, fromCache),
    user,
    online,
    key,
    sent,
    /** Batches wait for a server that does not answer, as offline. */
    offline: () => {
      commitResult = () => new Promise<void>(() => undefined);
    },
  };
}

describe('NotesService', () => {
  describe('Instructions for Claude, when the page goes before the cache has them (#198)', () => {
    const template = (instructions?: string) => ({
      id: 't1',
      data: {
        body: 'Journal entry\n',
        title: 'Journal entry',
        kind: 'template',
        ...(instructions === undefined ? {} : { instructions }),
      },
    });
    const DEFAULT = 'How to fill in or tidy notes made from this template.';
    const instructionWrites = (api: ReturnType<typeof setup>['api']) =>
      api.set.mock.calls.filter(([, , data]) => 'instructions' in data).map(([, , d]) => d);

    /** Typed, then the page reloads before the write is acknowledged. */
    function typedThenReloaded() {
      const first = setup();
      first.signIn('u1');
      first.push([template(DEFAULT)]);
      first.api.set.mockReturnValue(new Promise<void>(() => undefined));
      first.notes.setInstructions('t1', 'Ask how the day went.');
      expect(instructionWrites(first.api)).toEqual([
        expect.objectContaining({ instructions: 'Ask how the day went.', updatedBy: 'user' }),
      ]);
      const next = setup({ reload: true });
      next.signIn('u1');
      return next;
    }

    it('writes them again on the next load when the cache lost them', () => {
      const { api, push } = typedThenReloaded();
      push([template(DEFAULT)]);
      expect(instructionWrites(api)).toEqual([
        expect.objectContaining({ instructions: 'Ask how the day went.', updatedBy: 'user' }),
      ]);
      expect(api.set.mock.calls[0][1]).toBe('users/u1/notes/t1');
      expect(api.set.mock.calls[0][3]).toBe(true);
    });

    it('writes nothing again when the cache kept them', () => {
      const { api, push } = typedThenReloaded();
      push([template('Ask how the day went.')]);
      expect(api.set).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)).toBeNull();
    });

    it('never writes over words someone else put in the field since', () => {
      const { api, push } = typedThenReloaded();
      push([template('Claude’s newer words.')]);
      expect(api.set).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)).toBeNull();
    });

    it('writes them again only on the load, not on later snapshots', () => {
      const { api, push } = typedThenReloaded();
      push([template(DEFAULT)]);
      push([template(DEFAULT)]);
      expect(instructionWrites(api)).toHaveLength(1);
    });

    it('brings back the last words when the cache kept only the first edit (#200)', () => {
      const first = setup();
      first.signIn('u1');
      first.push([template(DEFAULT)]);
      first.api.set.mockReturnValue(new Promise<void>(() => undefined));
      first.notes.setInstructions('t1', 'Ask how the day went.');
      // The cache shows the first edit: it holds it.
      first.push([template('Ask how the day went.')]);
      first.notes.setInstructions('t1', 'Ask how the day went, and why.');
      const { api, push, signIn } = setup({ reload: true });
      signIn('u1');
      push([template('Ask how the day went.')]);
      expect(instructionWrites(api)).toEqual([
        expect.objectContaining({ instructions: 'Ask how the day went, and why.' }),
      ]);
    });

    it.each([DEFAULT, 'Ask how the day went.'])(
      'brings back the last words when edits came faster than the cache, finding %j (#200)',
      (found) => {
        const first = setup();
        first.signIn('u1');
        first.push([template(DEFAULT)]);
        first.api.set.mockReturnValue(new Promise<void>(() => undefined));
        // Two edits before the cache showed the first.
        first.notes.setInstructions('t1', 'Ask how the day went.');
        first.notes.setInstructions('t1', 'Ask how the day went, and why.');
        const { api, push, signIn } = setup({ reload: true });
        signIn('u1');
        push([template(found)]);
        expect(instructionWrites(api)).toEqual([
          expect.objectContaining({ instructions: 'Ask how the day went, and why.' }),
        ]);
      },
    );

    it('brings back words typed but not yet written, from the field held as typed (#200)', () => {
      const first = setup();
      first.signIn('u1');
      first.push([template(DEFAULT)]);
      expect(first.notes.holdInstructions('t1', 'Ask how')).toBe(true);
      expect(first.api.set).not.toHaveBeenCalled();
      const { api, push, signIn } = setup({ reload: true });
      signIn('u1');
      push([template(DEFAULT)]);
      expect(instructionWrites(api)).toEqual([
        expect.objectContaining({ instructions: 'Ask how', updatedBy: 'user' }),
      ]);
    });

    it('never trusts the persisted cache: a stale one showing the base writes nothing (review on #204)', () => {
      const { api, push } = typedThenReloaded();
      push([template(DEFAULT)], { fromCache: true });
      expect(api.set).not.toHaveBeenCalled();
      // The server has newer words, written while this device was away.
      push([template('Claude’s newer words.')]);
      expect(api.set).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)).toBeNull();
    });

    it('writes them once the server still shows the base, after the cache did', () => {
      const { api, push } = typedThenReloaded();
      push([template(DEFAULT)], { fromCache: true });
      push([template(DEFAULT)]);
      expect(instructionWrites(api)).toHaveLength(1);
    });

    it('keeps them across loads while offline, until the server answers', () => {
      const { push } = typedThenReloaded();
      push([template(DEFAULT)], { fromCache: true });
      const { api, push: again, signIn } = setup({ reload: true });
      signIn('u1');
      again([template(DEFAULT)], { fromCache: true });
      expect(api.set).not.toHaveBeenCalled();
      again([template(DEFAULT)]);
      expect(instructionWrites(api)).toHaveLength(1);
    });

    it('forgets them for a template the server does not have', () => {
      const { api, push } = typedThenReloaded();
      push([]);
      expect(api.set).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)).toBeNull();
    });

    it('leaves words typed again since the load to their own write (#204)', () => {
      const { api, push, notes } = typedThenReloaded();
      push([template(DEFAULT)], { fromCache: true });
      api.set.mockReturnValue(new Promise<void>(() => undefined));
      notes.setInstructions('t1', 'Ask about the weather.');
      // The server's view carries this device's own write, as the cache shows it.
      push([template('Ask about the weather.')]);
      expect(instructionWrites(api)).toEqual([
        expect.objectContaining({ instructions: 'Ask about the weather.' }),
      ]);
      expect(JSON.parse(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)!)).toEqual({
        // The lost words stay among the earlier ones the field may hold.
        t1: {
          uid: 'u1',
          value: 'Ask about the weather.',
          base: DEFAULT,
          earlier: ['Ask how the day went.'],
        },
      });
    });

    it('never writes the older words over ones typed since, whatever the server shows', () => {
      const { api, push, notes } = typedThenReloaded();
      push([template(DEFAULT)], { fromCache: true });
      api.set.mockReturnValue(new Promise<void>(() => undefined));
      notes.setInstructions('t1', 'Ask about the weather.');
      push([template(DEFAULT)]);
      const written = instructionWrites(api).map((d) => d['instructions']);
      expect(new Set(written)).toEqual(new Set(['Ask about the weather.']));
    });

    it('holds them for any note that takes them (#231), and nothing for a recipe', () => {
      const { notes, signIn, push } = setup();
      signIn('u1');
      push([
        { id: 'n1', data: { body: 'x', kind: 'text' } },
        { id: 'r1', data: { body: 'x', kind: 'recipe' } },
      ]);
      expect(notes.holdInstructions('r1', 'Ask')).toBe(false);
      expect(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)).toBeNull();
      expect(notes.holdInstructions('n1', 'Ask')).toBe(true);
      expect(JSON.parse(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)!)).toEqual({
        n1: expect.objectContaining({ uid: 'u1', value: 'Ask' }),
      });
    });

    it('never writes them into another account’s notes', () => {
      const first = setup();
      first.signIn('u1');
      first.push([template(DEFAULT)]);
      first.notes.holdInstructions('t1', 'Ask how');
      const { api, push, signIn } = setup({ reload: true });
      signIn('u2');
      push([template(DEFAULT)]);
      expect(api.set).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)).not.toBeNull();
    });

    it('forgets them once the server has them', async () => {
      const { notes, signIn, push } = setup();
      signIn('u1');
      push([template(DEFAULT)]);
      notes.setInstructions('t1', 'Ask how the day went.');
      expect(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)).not.toBeNull();
      await Promise.resolve();
      await Promise.resolve();
      expect(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)).toBeNull();
    });

    it('writes them again into a field that was absent, as before #111', () => {
      const first = setup();
      first.signIn('u1');
      first.push([template()]);
      first.api.set.mockReturnValue(new Promise<void>(() => undefined));
      first.notes.setInstructions('t1', 'Ask how the day went.');
      const { api, push, signIn } = setup({ reload: true });
      signIn('u1');
      push([template()]);
      expect(instructionWrites(api)).toEqual([
        expect.objectContaining({ instructions: 'Ask how the day went.' }),
      ]);
    });
  });

  describe('Note text, when the page goes before the cache has it (#200)', () => {
    const note = (body: string, more: Record<string, unknown> = {}) => ({
      id: 'n1',
      data: { body, title: body, titleSource: 'words', kind: 'text', ...more },
    });
    const bodyWrites = (api: ReturnType<typeof setup>['api']) =>
      api.set.mock.calls.filter(([, , data]) => 'body' in data);

    /** Saved over `found` (none: a new note), then reloaded before the write is acknowledged. */
    function savedThenReloaded(
      found: ReturnType<typeof note>[],
      ...saves: [string, Parameters<NotesService['save']>[2]?][]
    ) {
      const first = setup();
      first.signIn('u1');
      first.push(found);
      first.api.set.mockReturnValue(new Promise<void>(() => undefined));
      for (const [body, opts] of saves) first.notes.save('n1', body, opts);
      const next = setup({ reload: true });
      next.signIn('u1');
      return next;
    }

    it('makes a new note again, whole, when the cache never took it', () => {
      const { api, push } = savedThenReloaded([], ['Fresh words']);
      push([]);
      const writes = bodyWrites(api);
      expect(writes).toHaveLength(1);
      const [, path, data, merge] = writes[0];
      expect(path).toBe('users/u1/notes/n1');
      expect(merge).toBe(false);
      expect(data).toMatchObject({
        kind: 'text',
        body: 'Fresh words',
        title: 'Fresh words',
        titleSource: 'words',
        archived: false,
        updatedBy: 'user',
      });
    });

    it('writes nothing again when the cache took it, and forgets it', () => {
      const { api, push } = savedThenReloaded([], ['Fresh words']);
      push([note('Fresh words')]);
      expect(api.set).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_SAVES_KEY)).toBeNull();
    });

    it('writes an edit again over the text it was typed over, merged', () => {
      const { api, push } = savedThenReloaded([note('one')], ['one two', { base: 'one' }]);
      push([note('one')]);
      const writes = bodyWrites(api);
      expect(writes).toHaveLength(1);
      expect(writes[0][3]).toBe(true);
      expect(writes[0][2]).toMatchObject({
        body: 'one two',
        title: 'one two',
        baseHash: keyedHash(writes[0][1].split('/').pop()!, 'one'),
      });
    });

    it('keeps a title Eric chose when the edit comes back', () => {
      const { api, push } = savedThenReloaded(
        [note('one', { title: 'Mine', titleSource: 'user' })],
        ['one two'],
      );
      push([note('one', { title: 'Mine', titleSource: 'user' })]);
      const data = bodyWrites(api)[0][2];
      expect(data['body']).toBe('one two');
      expect(data).not.toHaveProperty('title');
    });

    it('never writes over text someone else put there since', () => {
      const { api, push } = savedThenReloaded([note('one')], ['one two']);
      push([note('Claude’s newer words')]);
      expect(api.set).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_SAVES_KEY)).toBeNull();
    });

    it('never brings back a note deleted since', () => {
      const { api, push } = savedThenReloaded([note('one')], ['one two']);
      push([]);
      expect(api.set).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_SAVES_KEY)).toBeNull();
    });

    it('brings back the last words when the cache kept only an earlier save', () => {
      const first = setup();
      first.signIn('u1');
      first.push([note('one')]);
      first.api.set.mockReturnValue(new Promise<void>(() => undefined));
      first.notes.save('n1', 'one two');
      first.push([note('one two')]);
      first.notes.save('n1', 'one two three');
      const { api, push, signIn } = setup({ reload: true });
      signIn('u1');
      push([note('one two')]);
      expect(bodyWrites(api).map(([, , d]) => d['body'])).toEqual(['one two three']);
    });

    it.each(['one', 'one two'])(
      'brings back the last words when saves came faster than the cache, finding %j',
      (found) => {
        const { api, push } = savedThenReloaded([note('one')], ['one two'], ['one two three']);
        push([note(found)]);
        expect(bodyWrites(api).map(([, , d]) => d['body'])).toEqual(['one two three']);
      },
    );

    it('never trusts the persisted cache: a stale one showing the base writes nothing (review on #204)', () => {
      const { api, push } = savedThenReloaded([note('one')], ['one two']);
      push([note('one')], { fromCache: true });
      expect(api.set).not.toHaveBeenCalled();
      push([note('Claude’s newer words')]);
      expect(api.set).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_SAVES_KEY)).toBeNull();
    });

    it('writes it once the server still shows the base, after the cache did', () => {
      const { api, push } = savedThenReloaded([note('one')], ['one two']);
      push([note('one')], { fromCache: true });
      push([note('one')]);
      expect(bodyWrites(api).map(([, , d]) => d['body'])).toEqual(['one two']);
    });

    it('keeps it across loads while offline, until the server answers', () => {
      const { push } = savedThenReloaded([note('one')], ['one two']);
      push([note('one')], { fromCache: true });
      const { api, push: again, signIn } = setup({ reload: true });
      signIn('u1');
      again([note('one')], { fromCache: true });
      expect(api.set).not.toHaveBeenCalled();
      again([note('one')]);
      expect(bodyWrites(api)).toHaveLength(1);
    });

    it('writes again only on the load, not on later snapshots', () => {
      const { api, push } = savedThenReloaded([note('one')], ['one two']);
      push([note('one')]);
      push([note('one')]);
      expect(bodyWrites(api)).toHaveLength(1);
    });

    it('writes a restore again as a restore', () => {
      const { api, push } = savedThenReloaded([note('newer')], ['older', { restore: true }]);
      push([note('newer')]);
      expect(bodyWrites(api)[0][2]['deviceId']).toMatch(new RegExp(`${RESTORE_SUFFIX}$`));
    });

    it('forgets it once the server has it', async () => {
      const { notes, signIn, push } = setup();
      signIn('u1');
      push([]);
      notes.save('n1', 'Fresh words');
      expect(localStorage.getItem(PENDING_SAVES_KEY)).not.toBeNull();
      await Promise.resolve();
      await Promise.resolve();
      expect(localStorage.getItem(PENDING_SAVES_KEY)).toBeNull();
    });

    it('keeps the newer words when an older save is acknowledged', async () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([]);
      let ack: () => void = () => undefined;
      api.set.mockReturnValueOnce(new Promise<void>((resolve) => (ack = resolve)));
      api.set.mockReturnValueOnce(new Promise<void>(() => undefined));
      notes.save('n1', 'one');
      notes.save('n1', 'one two');
      ack();
      await Promise.resolve();
      await Promise.resolve();
      expect(JSON.parse(localStorage.getItem(PENDING_SAVES_KEY)!)['n1']).toMatchObject({
        value: 'one two',
      });
    });

    it('forgets a note removed here', () => {
      const first = setup();
      first.signIn('u1');
      first.push([note('one')]);
      first.api.set.mockReturnValue(new Promise<void>(() => undefined));
      first.notes.save('n1', '');
      first.notes.remove('n1');
      expect(localStorage.getItem(PENDING_SAVES_KEY)).toBeNull();
    });

    it('never writes it into another account’s notes', () => {
      const { api, push, signIn } = savedThenReloaded([], ['Fresh words']);
      signIn('u2');
      push([]);
      expect(api.set).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_SAVES_KEY)).not.toBeNull();
    });
  });

  describe('A recipe’s or a concept’s name, when the page goes before the cache has it (#205)', () => {
    const recipe = (title: string) => ({
      id: 'r1',
      data: { body: '', title, kind: 'recipe', titleSource: 'user' },
    });
    const concept = (title: string, more: Record<string, unknown> = {}) => ({
      id: 'c-vikas',
      data: { body: 'Glazes.', title, kind: 'concept', titleSource: 'user', ...more },
    });
    /** An empty stub concept, made by linking [[Vikas S.]] first. */
    const stub = { id: 'c-vikas-s', data: { body: '', title: 'Vikas S.', kind: 'concept' } };
    const writes = (api: ReturnType<typeof setup>['api']) =>
      api.set.mock.calls.map(([, path, data]) => [path, data]);
    const stored = () => localStorage.getItem(PENDING_NAMES_KEY);

    /** Typed (and, with `written`, written unacknowledged), then reloaded. */
    function typedThenReloaded(
      docs: Parameters<ReturnType<typeof setup>['push']>[0],
      id: string,
      name: string,
      { written = false, as = 'u1' } = {},
    ) {
      const first = setup();
      first.signIn('u1');
      first.push(docs);
      first.api.set.mockReturnValue(new Promise<void>(() => undefined));
      if (written) first.notes.rename(id, name);
      else expect(first.notes.holdName(id, name)).toBe(true);
      expect(first.api.set.mock.calls.length > 0).toBe(written);
      const next = setup({ reload: true });
      next.signIn(as);
      return next;
    }

    it.each([false, true])(
      'renames a recipe again when the server still shows its old name (written: %s)',
      (written) => {
        const { api, push } = typedThenReloaded([recipe('Dal')], 'r1', 'Red lentil dal', {
          written,
        });
        push([recipe('Dal')]);
        expect(writes(api)).toEqual([
          [
            'users/u1/notes/r1',
            expect.objectContaining({
              title: 'Red lentil dal',
              titleSource: 'user',
              updatedBy: 'user',
            }),
          ],
        ]);
        expect(api.set.mock.calls[0][3]).toBe(true);
      },
    );

    it('writes nothing again when the server has the name, and forgets it', () => {
      const { api, push } = typedThenReloaded([recipe('Dal')], 'r1', 'Red lentil dal');
      push([recipe('Red lentil dal')]);
      expect(api.set).not.toHaveBeenCalled();
      expect(stored()).toBeNull();
    });

    it('never writes over a name someone else gave it since', () => {
      const { api, push } = typedThenReloaded([recipe('Dal')], 'r1', 'Red lentil dal');
      push([recipe('Tarka dal')]);
      expect(api.set).not.toHaveBeenCalled();
      expect(stored()).toBeNull();
    });

    it('forgets the name of a note the server does not have', () => {
      const { api, push } = typedThenReloaded([recipe('Dal')], 'r1', 'Red lentil dal');
      push([]);
      expect(api.set).not.toHaveBeenCalled();
      expect(stored()).toBeNull();
    });

    it('never trusts the persisted cache, and waits for the server', () => {
      const { api, push } = typedThenReloaded([recipe('Dal')], 'r1', 'Red lentil dal');
      push([recipe('Dal')], { fromCache: true });
      expect(api.set).not.toHaveBeenCalled();
      push([recipe('Dal')]);
      push([recipe('Dal')]);
      expect(writes(api)).toHaveLength(1);
    });

    it('never renames into another account’s notes', () => {
      const { api, push } = typedThenReloaded([recipe('Dal')], 'r1', 'Red lentil dal', {
        as: 'u2',
      });
      push([recipe('Dal')]);
      expect(api.set).not.toHaveBeenCalled();
      expect(stored()).not.toBeNull();
    });

    it('renames a concept again through the rename: its old name kept, a stub folded in', () => {
      const { api, push } = typedThenReloaded(
        [concept('Vikas', { synonyms: ['Vik'] }), stub],
        'c-vikas',
        'Vikas S.',
      );
      push([concept('Vikas', { synonyms: ['Vik'] }), stub]);
      expect(writes(api)).toEqual([
        [
          'users/u1/notes/c-vikas',
          expect.objectContaining({ title: 'Vikas S.', synonyms: ['Vik', 'Vikas'] }),
        ],
        [
          'users/u1/notes/c-vikas-s',
          expect.objectContaining({ archived: true, mergedInto: 'c-vikas' }),
        ],
      ]);
    });

    it('renames a concept written but never acknowledged once, not twice', () => {
      const { api, push } = typedThenReloaded([concept('Vikas'), stub], 'c-vikas', 'Vikas S.', {
        written: true,
      });
      push([concept('Vikas'), stub]);
      expect(writes(api)[0]).toEqual([
        'users/u1/notes/c-vikas',
        expect.objectContaining({ title: 'Vikas S.', synonyms: ['Vikas'] }),
      ]);
      expect(writes(api)).toHaveLength(2);
    });

    it('leaves a concept someone renamed since, forgetting the name', () => {
      const { api, push } = typedThenReloaded([concept('Vikas')], 'c-vikas', 'Vikas S.');
      push([concept('Vikas Singh')]);
      expect(api.set).not.toHaveBeenCalled();
      expect(stored()).toBeNull();
    });

    it('forgets a concept’s name the server has', () => {
      const { api, push } = typedThenReloaded([concept('Vikas')], 'c-vikas', 'Vikas S.');
      push([concept('Vikas S.', { synonyms: ['Vikas'] })]);
      expect(api.set).not.toHaveBeenCalled();
      expect(stored()).toBeNull();
    });

    it('forgets a concept’s name that another note took since, writing nothing', () => {
      const { api, push } = typedThenReloaded([concept('Vikas')], 'c-vikas', 'Vikas S.');
      push([concept('Vikas'), { ...stub, data: { ...stub.data, body: 'Not a stub now.' } }]);
      expect(api.set).not.toHaveBeenCalled();
      expect(stored()).toBeNull();
    });

    it('forgets the name once the server has it, unless newer words wait', async () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([recipe('Dal')]);
      let ack!: () => void;
      api.set.mockReturnValueOnce(new Promise<void>((done) => (ack = () => done())));
      notes.rename('r1', 'Red lentil');
      notes.holdName('r1', 'Red lentil dal');
      ack();
      await Promise.resolve();
      await Promise.resolve();
      expect(JSON.parse(stored()!)['r1']).toMatchObject({ value: 'Red lentil dal' });
      notes.rename('r1', 'Red lentil dal');
      await Promise.resolve();
      await Promise.resolve();
      expect(stored()).toBeNull();
    });

    it('keeps no name that is taken or blank, and forgets a note removed here', () => {
      const { notes, signIn, push } = setup();
      signIn('u1');
      push([recipe('Dal'), concept('Vikas'), { ...stub, data: { ...stub.data, body: 'x' } }]);
      expect(notes.rename('c-vikas', 'Vikas S.')).toEqual(['Vikas S.']);
      expect(notes.rename('r1', 'vikas s.')).toEqual(['vikas s.']);
      expect(stored()).toBeNull();
      notes.holdName('r1', 'Red');
      expect(notes.holdName('r1', '  ')).toBe(false);
      expect(stored()).toBeNull();
      expect(notes.holdName('n1', 'Red')).toBe(false);
      notes.holdName('r1', 'Red');
      notes.holdName('c-vikas', 'Vikas S');
      notes.remove('r1');
      notes.remove('c-vikas');
      expect(stored()).toBeNull();
    });
  });

  it('listens to the signed-in user’s notes and maps them', () => {
    const { notes, api, signIn, push } = setup();
    expect(notes.ready).toBe(false);
    signIn('u1');
    expect(notes.ready).toBe(false);
    expect(api.listen).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/notes',
      expect.any(Function),
      expect.any(Function),
    );
    push([
      {
        id: 'n1',
        data: {
          body: 'hi',
          title: 'hi',
          titleSource: 'words',
          archived: false,
          updatedAt: { toMillis: () => 5 },
        },
      },
    ]);
    expect(notes.loaded()).toBe(true);
    expect(notes.notes()).toEqual([
      {
        id: 'n1',
        body: 'hi',
        title: 'hi',
        titleSource: 'words',
        kind: 'text',
        links: [],
        archived: false,
        updatedAt: 5,
      },
    ]);
  });

  it('sends a note to an assistant through the cache, and takes it back (#143)', () => {
    const { notes, api, signIn } = setup();
    signIn('u1');
    notes.save('n1', 'Glaze notes');
    notes.sendToAssistant('n1', '  file this\nunder pottery ');
    expect(api.set).toHaveBeenLastCalledWith(
      expect.anything(),
      'users/u1/notes/n1',
      {
        sendState: 'queued',
        sendAsk: 'file this under pottery',
        sentAt: 'SERVER_TIME',
        sendOutcome: REMOVED,
        // Sent by Eric himself now, not on arrival (#214).
        sentOnArrival: REMOVED,
      },
      true,
    );
    notes.sendToAssistant('n1', ' ');
    expect(api.set.mock.lastCall![2]).toMatchObject({ sendState: 'queued', sendAsk: REMOVED });
    notes.sendToAssistant('nope', 'x');
    expect(api.set.mock.lastCall![1]).toBe('users/u1/notes/n1');
  });

  it('writes a new note in full, then merges updates', () => {
    const { notes, api, signIn } = setup();
    signIn('u1');
    notes.save('n1', 'Buy a card for nephew');
    expect(api.set).toHaveBeenLastCalledWith(
      expect.anything(),
      'users/u1/notes/n1',
      expect.objectContaining({
        kind: 'text',
        body: 'Buy a card for nephew',
        title: 'Buy a card for nephew',
        titleSource: 'words',
        links: [],
        tags: [],
        archived: false,
        createdAt: 'SERVER_TIME',
        updatedAt: 'SERVER_TIME',
        updatedBy: 'user',
      }),
      false,
    );
    notes.save('n1', 'Buy a card');
    const [, , update, merge] = api.set.mock.lastCall!;
    expect(merge).toBe(true);
    expect(update).not.toHaveProperty('kind');
    expect(update).not.toHaveProperty('createdAt');
    expect(update).toMatchObject({ body: 'Buy a card', title: 'Buy a card' });
  });

  it('writes the ids a note links to, resolving names it knows', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([
      { id: 'c-vikas', data: { body: '', title: 'Vikas', kind: 'concept', synonyms: ['Vik'] } },
      { id: 'n9', data: { body: 'eggs', title: 'Groceries', kind: 'text' } },
    ]);
    notes.save('n1', 'Ask [[vik]] about [[Groceries]] and [[Pottery|the wheel]], not `[[code]]`');
    expect(api.set.mock.lastCall![2]).toMatchObject({ links: ['c-vikas', 'n9', 'c-pottery'] });
  });

  it('makes stub concepts only if absent, once loaded and online', async () => {
    const { notes, api, signIn, push, online } = setup();
    signIn('u1');
    expect(notes.createConcept('Kiln')).toBe('c-kiln');
    expect(api.createIfAbsent).not.toHaveBeenCalled();
    online.set(false);
    push([{ id: 'c-vikas', data: { body: '', title: 'Vikas', kind: 'concept' } }]);
    expect(api.createIfAbsent).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PENDING_CONCEPTS_KEY)!)).toEqual(['Kiln']);

    online.set(true);
    notes.plantConcepts('Ask [[Vikas]] about the [[Kiln]], the [[kiln]] and [[Glaze]]');
    expect(api.createIfAbsent.mock.calls.map(([, path]) => path)).toEqual([
      'users/u1/notes/c-kiln',
      'users/u1/notes/c-glaze',
    ]);
    expect(api.createIfAbsent.mock.calls[0][2]).toMatchObject({
      kind: 'concept',
      body: '',
      title: 'Kiln',
      titleSource: 'user',
      conceptType: 'other',
      links: [],
      archived: false,
    });
    expect(api.set).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(localStorage.getItem(PENDING_CONCEPTS_KEY)).toBeNull();
  });

  it('makes a new name on a Moods line a mood, even made later (#40)', async () => {
    const { notes, api, signIn, push, online } = setup();
    signIn('u1');
    online.set(false);
    push([{ id: 'c-calm', data: { body: '', title: 'calm', kind: 'concept' } }]);
    notes.plantConcepts('Feelings\nMoods: [[calm]], [[Wistful]]\nThought of [[Kiln]].');
    expect(api.createIfAbsent).not.toHaveBeenCalled();
    online.set(true);
    notes.makePendingConcepts();
    const made = Object.fromEntries(
      api.createIfAbsent.mock.calls.map(([, path, data]) => [path, data['conceptType']]),
    );
    expect(made).toEqual({ 'users/u1/notes/c-wistful': 'mood', 'users/u1/notes/c-kiln': 'other' });
    await Promise.resolve();
    await Promise.resolve();
    expect(localStorage.getItem(PENDING_MOODS_KEY)).toBeNull();
  });

  describe('naming a concept in Trash again (#217, review on #230)', () => {
    const at = (ms: number) => ({ toMillis: () => ms });
    const kiln = {
      id: 'c-kiln',
      data: {
        body: 'Cone 6, shelf 2',
        title: 'Kiln',
        kind: 'concept',
        conceptType: 'project',
        archived: false,
        deletedAt: at(CLOCK - 1000),
      },
    };
    const restores = (api: ReturnType<typeof setup>['api']) =>
      api.set.mock.calls.filter(([, , data]) => data['deletedAt'] === REMOVED);

    it('brings it back as Restore does, its text and filing kept, nothing made', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([kiln]);
      notes.plantConcepts('Fire the [[Kiln]] tomorrow');
      expect(api.createIfAbsent).not.toHaveBeenCalled();
      expect(restores(api)).toEqual([
        [
          expect.anything(),
          'users/u1/notes/c-kiln',
          {
            deletedAt: REMOVED,
            updatedAt: 'SERVER_TIME',
            updatedBy: 'user',
            deviceId: notes.deviceId(),
          },
          true,
        ],
      ]);
      expect(localStorage.getItem(PENDING_CONCEPTS_KEY)).toBeNull();
    });

    it('brings back one named while it waited on the device', () => {
      const { notes, api, signIn, push, online } = setup();
      signIn('u1');
      online.set(false);
      push([]);
      notes.createConcept('Kiln');
      expect(JSON.parse(localStorage.getItem(PENDING_CONCEPTS_KEY)!)).toEqual(['Kiln']);
      push([kiln]);
      online.set(true);
      notes.makePendingConcepts();
      expect(api.createIfAbsent).not.toHaveBeenCalled();
      expect(restores(api)).toHaveLength(1);
      expect(localStorage.getItem(PENDING_CONCEPTS_KEY)).toBeNull();
    });

    it('keeps the name waiting when the server has it but this device has not seen it', async () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([]);
      api.createIfAbsent.mockResolvedValueOnce(false);
      notes.createConcept('Kiln');
      await new Promise((r) => setTimeout(r));
      // Not made, and not known here yet: it waits for the snapshot.
      expect(JSON.parse(localStorage.getItem(PENDING_CONCEPTS_KEY)!)).toEqual(['Kiln']);
      push([kiln]);
      expect(restores(api)).toHaveLength(1);
      expect(localStorage.getItem(PENDING_CONCEPTS_KEY)).toBeNull();
      expect(api.createIfAbsent).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps a name waiting when the server cannot be reached', async () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([]);
    api.createIfAbsent.mockRejectedValueOnce(new Error('unavailable'));
    notes.createConcept('Kiln');
    await new Promise((r) => setTimeout(r));
    expect(JSON.parse(localStorage.getItem(PENDING_CONCEPTS_KEY)!)).toEqual(['Kiln']);
    notes.makePendingConcepts();
    expect(api.createIfAbsent).toHaveBeenCalledTimes(2);
  });

  it('renames a concept, keeping the old name as another name', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([
      {
        id: 'c-kiln',
        data: { body: '', title: 'Kiln', kind: 'concept', synonyms: ['Oven'], titleSource: 'user' },
      },
      { id: 'n1', data: { body: 'not a concept', title: 'n' } },
    ]);
    notes.updateConcept('c-kiln', { title: 'The kiln' });
    expect(api.set).toHaveBeenLastCalledWith(
      expect.anything(),
      'users/u1/notes/c-kiln',
      expect.objectContaining({
        title: 'The kiln',
        titleSource: 'user',
        synonyms: ['Oven', 'Kiln'],
        updatedBy: 'user',
      }),
      true,
    );
    notes.updateConcept('c-kiln', {
      synonyms: ['oven', 'Oven', ' ', 'Kiln'],
      conceptType: 'project',
    });
    expect(api.set.mock.lastCall![2]).toMatchObject({
      synonyms: ['Oven'],
      conceptType: 'project',
    });
    api.set.mockClear();
    notes.updateConcept('n1', { title: 'Nope' });
    notes.updateConcept('c-kiln', { title: 'Kiln' });
    expect(api.set).not.toHaveBeenCalled();
  });

  it('files a project under a parent, never under itself or below it (#41)', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    const project = (title: string, parent?: string) => ({
      body: '',
      title,
      kind: 'concept',
      conceptType: 'project',
      ...(parent ? { parent } : {}),
    });
    push([
      { id: 'sprout', data: { ...project('Sprout'), projectKind: 'build', projectStatus: 'x' } },
      { id: 'leaf', data: project('Leaf', 'sprout') },
      { id: 'studio', data: project('Sprout studio') },
    ]);
    // An unknown status is not read as one.
    expect(notes.find('sprout')).toMatchObject({ projectKind: 'build' });
    expect(notes.find('sprout')?.projectStatus).toBeUndefined();
    expect(notes.find('leaf')?.parent).toBe('sprout');
    api.set.mockClear();
    notes.updateConcept('sprout', { parent: 'leaf' });
    notes.updateConcept('sprout', { parent: 'sprout' });
    expect(api.set).not.toHaveBeenCalled();
    notes.updateConcept('leaf', { parent: 'studio', projectStatus: 'waiting' });
    expect(api.set.mock.lastCall![2]).toMatchObject({ parent: 'studio', projectStatus: 'waiting' });
    notes.updateConcept('leaf', { parent: null, projectKind: 'content' });
    expect(api.set.mock.lastCall![2]).toMatchObject({ parent: REMOVED, projectKind: 'content' });
  });

  it('makes a recipe with its sections, refusing a name already taken (#127)', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([{ id: 'c-kiln', data: { body: 'Cone 6.', title: 'Kiln', kind: 'concept' } }]);
    expect(notes.createRecipe('kiln')).toBeUndefined();
    expect(notes.createRecipe('  ')).toBeUndefined();
    const id = notes.createRecipe(' Shakshuka ')!;
    expect(id).toBeTruthy();
    const [, path, data, merge] = api.set.mock.lastCall!;
    expect(path).toBe(`users/u1/notes/${id}`);
    expect(merge).toBe(false);
    expect(data).toMatchObject({
      kind: 'recipe',
      title: 'Shakshuka',
      titleSource: 'user',
      body: '## Ingredients\n\n## Method\n\n## Notes\n',
    });
    expect(notes.exists(id)).toBe(true);
  });

  it('folds an empty stub concept holding the recipe’s name into it (#127)', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    // [[Dal]] was linked before the recipe: an empty stub holds the name.
    push([{ id: 'c-dal', data: { body: '', title: 'Dal', kind: 'concept' } }]);
    const id = notes.createRecipe('Dal')!;
    expect(id).toBeTruthy();
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/notes/c-dal',
      expect.objectContaining({ archived: true, mergedInto: id }),
      true,
    ]);
  });

  it('makes a recipe for shared words as an import already failed, once (2026-11-14)', async () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([]);
    expect(notes.sharedRecipe('not a link', 'r9')).toBeUndefined();
    const written = notes.sharedRecipe(' https://refused.invalid/gratin ', 'r9')!;
    await expect(written).resolves.toBeUndefined();
    const [, path, data, merge] = api.set.mock.lastCall!;
    expect(path).toBe('users/u1/notes/r9');
    expect(merge).toBe(false);
    // Failed already, so the trigger (requested only) never claims it.
    expect(data).toMatchObject({
      kind: 'recipe',
      title: 'Recipe from refused.invalid',
      source: { url: 'https://refused.invalid/gratin' },
      importState: 'failed',
      importError: SHARED_IMPORT_WAITING,
      updatedBy: 'user',
    });
    // Asked again, the same recipe: no second write.
    api.set.mockClear();
    expect(notes.sharedRecipe('https://refused.invalid/gratin', 'r9')).toBe(written);
    expect(api.set).not.toHaveBeenCalled();

    push([
      {
        id: 'r9',
        data: {
          body: '',
          title: 'Recipe from refused.invalid',
          kind: 'recipe',
          importState: 'failed',
        },
      },
    ]);
    notes.importFailed('r9', 'nothing on the page read as a recipe');
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/notes/r9',
      expect.objectContaining({ importError: 'nothing on the page read as a recipe' }),
      true,
    ]);
  });

  it('dismisses a failed import, keeping the link and the text, and nothing else (2026-11-15)', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    const failed = {
      kind: 'recipe',
      body: '## Ingredients\n\n- 2 eggs\n\n## Method\n\n## Notes\n',
      title: 'Recipe from refused.invalid',
      source: { url: 'https://refused.invalid/g' },
      importState: 'failed',
      importError: 'it answered 402',
    };
    push([
      { id: 'r1', data: failed },
      { id: 'r2', data: { ...failed, importState: 'done' } },
      { id: 'r3', data: { ...failed, importState: 'requested' } },
      { id: 't1', data: { body: 'Plain', kind: 'text' } },
    ]);
    api.set.mockClear();
    for (const id of ['r2', 'r3', 't1']) notes.dismissImport(id);
    expect(api.set).not.toHaveBeenCalled();
    notes.dismissImport('r1');
    expect(api.set).toHaveBeenCalledTimes(1);
    const [, path, data, merge] = api.set.mock.lastCall!;
    expect(path).toBe('users/u1/notes/r1');
    expect(merge).toBe(true);
    expect(Object.keys(data as object).sort()).toEqual(
      ['deviceId', 'importError', 'importState', 'updatedAt', 'updatedBy'].sort(),
    );
    expect(data).toMatchObject({
      importState: REMOVED,
      importError: REMOVED,
      updatedBy: 'user',
    });
  });

  it('moves an untouched recipe stub a share made to Trash, and nothing else (review on #271)', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    const stub = {
      kind: 'recipe',
      body: '## Ingredients\n\n## Method\n\n## Notes\n',
      title: 'Recipe from refused.invalid',
      source: { url: 'https://refused.invalid/g' },
      importState: 'failed',
      importError: SHARED_IMPORT_WAITING,
    };
    push([
      { id: 'r1', data: stub },
      { id: 'r2', data: { ...stub, body: '## Ingredients\n- 2 eggs\n\n## Method\n' } },
      { id: 'r3', data: { ...stub, title: 'Gratin' } },
      { id: 'r4', data: { ...stub, importState: 'done' } },
    ]);
    api.set.mockClear();
    for (const id of ['r2', 'r3', 'r4']) {
      expect(notes.dropSharedRecipe(id, 'https://refused.invalid/g')).toBe(false);
    }
    expect(notes.dropSharedRecipe('r1', 'https://other.invalid/g')).toBe(false);
    expect(api.set).not.toHaveBeenCalled();
    expect(notes.dropSharedRecipe('r1', 'https://refused.invalid/g')).toBe(true);
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/notes/r1',
      expect.objectContaining({ deletedAt: expect.anything() }),
      true,
    ]);
  });

  it('changes a recipe’s name, servings and source link (#127)', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([
      { id: 'r1', data: { body: '', title: 'Shakshuka', kind: 'recipe', servings: 2 } },
      { id: 'c-kiln', data: { body: '', title: 'Kiln', kind: 'concept' } },
    ]);
    expect(notes.find('r1')).toMatchObject({ servings: 2 });
    api.set.mockClear();
    notes.updateRecipe('r1', { title: 'Kiln' });
    expect(api.set).not.toHaveBeenCalled();
    notes.updateRecipe('r1', { title: 'Eggs in purgatory', servings: 4, url: ' https://x.test ' });
    expect(api.set.mock.lastCall![2]).toMatchObject({
      title: 'Eggs in purgatory',
      titleSource: 'user',
      servings: 4,
      source: { url: 'https://x.test' },
    });
    notes.updateRecipe('r1', { servings: null });
    expect(api.set.mock.lastCall![2]).toMatchObject({ servings: REMOVED });
    api.set.mockClear();
    notes.updateRecipe('c-kiln', { servings: 3 });
    expect(api.set).not.toHaveBeenCalled();
  });

  it('keeps a project’s stages and tags, and an item’s stage (2026-10-17)', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([
      {
        id: 'pots',
        data: {
          body: '',
          title: 'Pots',
          kind: 'concept',
          conceptType: 'project',
          stages: ['plan', 'bisque'],
          itemTags: ['gift'],
        },
      },
      { id: 'vase', data: { body: '', title: 'Vase', kind: 'concept', stage: 'bisque' } },
    ]);
    expect(notes.find('pots')).toMatchObject({ stages: ['plan', 'bisque'], itemTags: ['gift'] });
    expect(notes.find('vase')?.stage).toBe('bisque');
    notes.updateConcept('pots', { stages: [' plan', 'bisque', 'plan', ''], itemTags: ['big'] });
    expect(api.set.mock.lastCall![2]).toMatchObject({
      stages: ['plan', 'bisque'],
      itemTags: ['big'],
    });
    notes.updateConcept('vase', { stage: 'plan', tags: ['gift'] });
    expect(api.set.mock.lastCall![2]).toMatchObject({ stage: 'plan', tags: ['gift'] });
    notes.updateConcept('vase', { stage: null });
    expect(api.set.mock.lastCall![2]).toMatchObject({ stage: REMOVED });
  });

  it('makes a new item in a project, or files the concept a name has (2026-10-17)', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([
      { id: 'pots', data: { body: '', title: 'Pots', kind: 'concept', conceptType: 'project' } },
      { id: 'c-cup', data: { body: '', title: 'Cup', kind: 'concept', synonyms: ['mug'] } },
    ]);
    expect(notes.createItem('pots', 'Teapot', 'plan')).toBe('c-teapot');
    expect(api.createIfAbsent.mock.lastCall![2]).toMatchObject({
      title: 'Teapot',
      conceptType: 'project',
      parent: 'pots',
      stage: 'plan',
    });
    expect(notes.createItem('pots', 'Mug')).toBe('c-cup');
    expect(api.set.mock.lastCall![2]).toMatchObject({ conceptType: 'project', parent: 'pots' });
    expect(notes.createItem('pots', 'pots')).toBeUndefined();
    api.set.mockClear();
    push([
      { id: 'pots', data: { body: '', title: 'Pots', kind: 'concept', conceptType: 'project' } },
      { id: 'c-vik', data: { body: '', title: 'Vik', kind: 'concept', conceptType: 'person' } },
      {
        id: 'c-studio',
        data: { body: '', title: 'Studio', kind: 'concept', conceptType: 'project' },
      },
      {
        id: 'c-room',
        data: { body: '', title: 'Room', kind: 'concept', conceptType: 'project', parent: 'pots' },
      },
    ]);
    // A person stays a person; a project never goes under its own child.
    expect(notes.createItem('pots', 'Vik')).toBeUndefined();
    expect(notes.createItem('c-room', 'Pots')).toBeUndefined();
    expect(api.set).not.toHaveBeenCalled();
    expect(notes.createItem('pots', 'Studio', 'plan')).toBe('c-studio');
    expect(api.set.mock.lastCall![2]).toMatchObject({ parent: 'pots', stage: 'plan' });
    expect(notes.createItem('pots', '  ')).toBeUndefined();
  });

  it('refuses a name another note already answers to', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([
      { id: 'c-guitar', data: { body: '', title: 'Guitar', kind: 'concept' } },
      { id: 'c-banjo', data: { body: '', title: 'Banjo', kind: 'concept', synonyms: ['Uke'] } },
    ]);
    expect(notes.updateConcept('c-guitar', { synonyms: ['banjo', 'UKE', 'Axe'] })).toEqual([
      'banjo',
      'UKE',
    ]);
    expect(api.set.mock.lastCall![2]).toMatchObject({ synonyms: ['Axe'] });
    api.set.mockClear();
    expect(notes.updateConcept('c-guitar', { title: 'Banjo' })).toEqual(['Banjo']);
    expect(api.set).not.toHaveBeenCalled();
  });

  it('folds in an empty stub concept that held the name, archiving it', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([
      { id: 'c-vikas', data: { body: '', title: 'Vikas', kind: 'concept' } },
      { id: 'c-vik', data: { body: '', title: 'Vik', kind: 'concept' } },
    ]);
    expect(notes.updateConcept('c-vikas', { synonyms: ['Vik'] })).toEqual([]);
    const calls = api.set.mock.calls.map(([, path, data]) => [path, data]);
    expect(calls[0]).toEqual([
      'users/u1/notes/c-vikas',
      expect.objectContaining({ synonyms: ['Vik'] }),
    ]);
    expect(calls[1]).toEqual([
      'users/u1/notes/c-vik',
      expect.objectContaining({ archived: true, mergedInto: 'c-vikas' }),
    ]);
  });

  it('keeps a title Eric set himself', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([{ id: 'n1', data: { body: 'x', title: 'Mine', titleSource: 'user', archived: false } }]);
    notes.save('n1', 'new words');
    const [, , update] = api.set.mock.lastCall!;
    expect(update).not.toHaveProperty('title');
    expect(update).not.toHaveProperty('titleSource');
  });

  it('keeps a Claude title until the next settle replaces it', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([
      { id: 'n1', data: { body: 'x', title: 'Loan call', titleSource: 'llm', archived: false } },
    ]);
    notes.save('n1', 'call the credit union instead');
    expect(api.set.mock.lastCall![2]).not.toHaveProperty('title');
  });

  it('settles a note that changed since its last settle, and only then', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    const at = (ms: number) => ({ toMillis: () => ms });
    push([
      { id: 'fresh', data: { body: 'never settled', updatedAt: at(5) } },
      { id: 'edited', data: { body: 'changed after', updatedAt: at(9), settledAt: at(5) } },
      { id: 'read', data: { body: 'only read', updatedAt: at(5), settledAt: at(9) } },
      { id: 'blank', data: { body: '  ' } },
    ]);
    for (const id of ['fresh', 'edited', 'read', 'blank']) notes.settle(id);
    expect(api.set.mock.calls.map(([, path, data, merge]) => [path, data, merge])).toEqual([
      ['users/u1/notes/fresh', { settledAt: 'SERVER_TIME' }, true],
      ['users/u1/notes/edited', { settledAt: 'SERVER_TIME' }, true],
    ]);
    notes.settle('read', { edited: true });
    expect(api.set.mock.lastCall![1]).toBe('users/u1/notes/read');
  });

  it('never settles a template, so its name stays its first line', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([{ id: 't1', data: { body: 'Journal', kind: 'template', templateMode: 'entry' } }]);
    notes.settle('t1', { edited: true });
    expect(api.set).not.toHaveBeenCalled();
    expect(notes.find('t1')).toMatchObject({ kind: 'template', templateMode: 'entry' });
  });

  it('writes a template, or a note from one, whole at once', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([]);
    notes.create('t1', 'Journal\nMood:', { kind: 'template', templateMode: 'living' });
    notes.create('e1', 'Journal\nMood:', { fromTemplate: 't1' });
    expect(api.set.mock.calls.map(([, path, data, merge]) => [path, data, merge])).toEqual([
      [
        'users/u1/notes/t1',
        expect.objectContaining({
          kind: 'template',
          templateMode: 'living',
          title: 'Journal',
          titleSource: 'words',
          archived: false,
        }),
        false,
      ],
      ['users/u1/notes/e1', expect.objectContaining({ kind: 'text', fromTemplate: 't1' }), false],
    ]);
    expect(notes.exists('e1')).toBe(true);
    notes.setTemplateMode('t1', 'entry');
    // Not a template on this device yet: nothing to change.
    expect(api.set).toHaveBeenCalledTimes(2);
  });

  describe('Trash (#217)', () => {
    const at = (ms: number) => ({ toMillis: () => ms });
    const glaze = { id: 'n1', data: { body: 'Glaze notes', archived: true } };

    it('puts a note in Trash with the device’s clock, and takes it out, merged as Eric’s', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([glaze]);
      notes.setDeleted('n1', true);
      expect(api.set.mock.lastCall!.slice(1)).toEqual([
        'users/u1/notes/n1',
        {
          deletedAt: { ms: CLOCK },
          updatedAt: 'SERVER_TIME',
          updatedBy: 'user',
          deviceId: notes.deviceId(),
        },
        true,
      ]);
      // Not in Trash yet on this device: nothing to restore.
      notes.setDeleted('n1', false);
      expect(api.set).toHaveBeenCalledTimes(1);
      push([{ id: 'n1', data: { ...glaze.data, deletedAt: at(CLOCK) } }]);
      notes.setDeleted('n1', false);
      expect(api.set.mock.lastCall![2]).toEqual({
        deletedAt: REMOVED,
        updatedAt: 'SERVER_TIME',
        updatedBy: 'user',
        deviceId: notes.deviceId(),
      });
      // Restore leaves the rest as it was: still archived.
      expect(api.set.mock.lastCall![2]).not.toHaveProperty('archived');
      // No note by that id: nothing written.
      notes.setDeleted('gone', true);
      expect(api.set).toHaveBeenCalledTimes(2);
    });

    it('keeps a deleted note out of the notes, in Trash the last deleted first', () => {
      const { notes, signIn, push } = setup();
      signIn('u1');
      push([
        { id: 'a', data: { body: 'Kiln log', title: 'Kiln log', archived: false } },
        { id: 'b', data: { body: 'Old list', archived: false, deletedAt: at(CLOCK - 5_000) } },
        { id: 'c', data: { body: 'Glaze', archived: true, deletedAt: at(CLOCK) } },
      ]);
      expect(notes.notes().map((n) => n.id)).toEqual(['a']);
      expect(notes.trash().map((n) => n.id)).toEqual(['c', 'b']);
      expect(notes.trashed('c')).toEqual(
        expect.objectContaining({ deletedAt: CLOCK, archived: true }),
      );
      // Gone to links, lists and opening, as a note that is not there.
      expect(notes.find('b')).toBeUndefined();
      expect(notes.exists('b')).toBe(false);
      expect(notes.names().has('kiln log')).toBe(true);
      expect([...notes.names().values()]).not.toContain('b');
    });

    it('never writes a full document over a note in Trash, nor settles it', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([{ id: 'b', data: { body: 'Old list', archived: false, deletedAt: at(CLOCK) } }]);
      notes.save('b', 'Old list, and eggs', { base: 'Old list' });
      expect(api.set.mock.lastCall![3]).toBe(true);
      expect(api.set.mock.lastCall![2]).not.toHaveProperty('kind');
      notes.settle('b', { edited: true });
      expect(api.set).toHaveBeenCalledTimes(1);
    });
  });

  it('sets and clears how a note takes new material, through the cache (#231)', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([
      { id: 'n1', data: { body: 'Kiln log', kind: 'text' } },
      { id: 'r1', data: { body: 'Soup', kind: 'recipe' } },
    ]);
    notes.setNoteMode('n1', 'log');
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/notes/n1',
      { mode: 'log', updatedAt: 'SERVER_TIME', updatedBy: 'user', deviceId: notes.deviceId() },
      true,
    ]);
    notes.setNoteMode('n1', undefined);
    expect(api.set.mock.lastCall![2]['mode']).toBe(REMOVED);
    // A recipe takes no mode.
    notes.setNoteMode('r1', 'list');
    expect(api.set).toHaveBeenCalledTimes(2);
  });

  it('archives a note and restores it, a merged field update stamped as Eric’s (#207)', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([{ id: 'n1', data: { body: 'Glaze notes', archived: false } }]);
    notes.setArchived('n1', true);
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/notes/n1',
      {
        archived: true,
        updatedAt: 'SERVER_TIME',
        updatedBy: 'user',
        deviceId: notes.deviceId(),
      },
      true,
    ]);
    notes.setArchived('n1', false);
    expect(api.set.mock.lastCall![2]['archived']).toBe(false);
    // No note by that id: nothing written.
    notes.setArchived('gone', true);
    expect(api.set).toHaveBeenCalledTimes(2);
    // A list from before #207 taken as a week's: its week, stamped the same way.
    notes.setWeek('n1', '2026-10-19');
    expect(api.set.mock.lastCall![2]).toEqual({
      periodStart: '2026-10-19',
      updatedAt: 'SERVER_TIME',
      updatedBy: 'user',
      deviceId: notes.deviceId(),
    });
  });

  it('holds a note back from Garden on arrival through the cache, and lets it go (#229)', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([{ id: 'n1', data: { body: 'Letter to Dad', archived: false } }]);
    expect(notes.find('n1')?.gardenHold).toBeUndefined();
    notes.setGardenHold('n1', true);
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/notes/n1',
      {
        gardenHold: true,
        updatedAt: 'SERVER_TIME',
        updatedBy: 'user',
        deviceId: notes.deviceId(),
      },
      true,
    ]);
    notes.setGardenHold('n1', false);
    expect(api.set.mock.lastCall![2]['gardenHold']).toBe(false);
    notes.setGardenHold('gone', true);
    expect(api.set).toHaveBeenCalledTimes(2);
    push([{ id: 'n1', data: { body: 'Letter to Dad', archived: false, gardenHold: true } }]);
    expect(notes.find('n1')?.gardenHold).toBe(true);
  });

  it('records the text a save was written over, or that it is not known', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([{ id: 'n1', data: { body: 'one', archived: false } }]);
    notes.save('n1', 'one two', { base: 'one' });
    expect(api.set.mock.lastCall![2]['baseHash']).toBe(keyedHash('n1', 'one'));
    notes.save('n1', 'one two three');
    expect(api.set.mock.lastCall![2]['baseHash']).toBe('');
  });

  it('writes Done shopping as its own writer too, so history keeps the list', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([{ id: 'n1', data: { body: '- [x] limes', archived: false } }]);
    notes.save('n1', '', { keep: true });
    expect(api.set.mock.lastCall![2]['deviceId']).toBe(notes.deviceId() + '~keep');
  });

  it('writes a restore as its own writer, so history keeps what it replaces', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([{ id: 'n1', data: { body: 'now', archived: false } }]);
    notes.save('n1', 'before', { restore: true });
    expect(api.set.mock.lastCall![2]['deviceId']).toBe(notes.deviceId() + '~restore');
  });

  it("drops Claude's title for the newer text on a restore", () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([{ id: 'n1', data: { body: 'newer text', title: 'Newer', titleSource: 'llm' } }]);
    notes.save('n1', 'older words here', { restore: true });
    expect(api.set.mock.lastCall![2]).toMatchObject({
      title: 'older words here',
      titleSource: 'words',
    });
  });

  it('removes a note and drops it from the list at once', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([{ id: 'n1', data: { body: 'x' } }]);
    notes.remove('n1');
    expect(api.remove).toHaveBeenCalledWith(expect.anything(), 'users/u1/notes/n1');
    expect(notes.notes()).toEqual([]);
  });

  it('refuses to save before sign-in and stops listening on sign-out', () => {
    const { notes, user, signIn } = setup();
    expect(() => notes.save('n1', 'x')).toThrow(/before sign-in/);
    signIn('u1');
    user.set(null);
    TestBed.tick();
    expect(notes.ready).toBe(false);
    expect(notes.notes()).toEqual([]);
  });

  it('keeps one device id', () => {
    const { notes } = setup();
    const id = notes.deviceId();
    expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(notes.deviceId()).toBe(id);
  });

  describe('sealed notes, read but never written over (note encryption step 3a)', () => {
    const UID = 'u1';
    const KEY = newDataKey();
    const seal = (id: string, field: 'body' | 'title', text: string, key: DataKey = KEY) =>
      sealText(key, aadFor(UID, id, field), text);
    /** A note document with its body and title sealed. */
    const sealedDoc = (id: string, body: string, title: string, more = {}) => ({
      id,
      data: { body: seal(id, 'body', body), title: seal(id, 'title', title), ...more },
    });
    /** Writes to note `id` as they went out, sealed values as sent. */
    const writesTo = (api: ReturnType<typeof setup>['api'], id: string) => [
      ...api.set.mock.calls.filter(([, path]) => path === `users/${UID}/notes/${id}`).map(asSent),
      ...api.createIfAbsent.mock.calls
        .filter(([, path]) => path === `users/${UID}/notes/${id}`)
        .map(asSent),
      ...api.remove.mock.calls.filter(([, path]) => path === `users/${UID}/notes/${id}`),
    ];

    describe('toRecord, the one decode point', () => {
      const opener = (key?: DataKey) => {
        const opened = new OpenedTexts();
        return { opened, open: opened.pass(() => key, UID) };
      };

      it('opens a sealed body and title with the key and the note’s own aad', () => {
        const { open } = opener(KEY);
        const note = toRecord('n1', sealedDoc('n1', 'Kiln\nfire at cone 6', 'Kiln').data, open);
        expect(note).toMatchObject({ id: 'n1', body: 'Kiln\nfire at cone 6', title: 'Kiln' });
        expect(note.locked).toBeUndefined();
      });

      it('passes plain text through unchanged, key or no key', () => {
        const data = { body: 'Plain words', title: 'Plain' };
        expect(toRecord('n1', data)).toEqual(toRecord('n1', data, opener(KEY).open));
        expect(toRecord('n1', data)).toMatchObject({ body: 'Plain words', title: 'Plain' });
        expect(toRecord('n1', data).locked).toBeUndefined();
      });

      it('locks a sealed note with no key: placeholders, never the sealed text', () => {
        const note = toRecord('n1', sealedDoc('n1', 'secret', 'Secret').data);
        expect(note).toMatchObject({ body: '', title: SEALED_TITLE, locked: true });
        expect(JSON.stringify(note)).not.toContain('\uE000');
      });

      it('locks a sealed note under a wrong key, or moved from another note', () => {
        expect(
          toRecord('n1', sealedDoc('n1', 'b', 't').data, opener(newDataKey()).open),
        ).toMatchObject({ body: '', title: SEALED_TITLE, locked: true });
        // Sealed for n2: its aad names n2, so it does not open as n1.
        expect(toRecord('n1', sealedDoc('n2', 'b', 't').data, opener(KEY).open).locked).toBe(true);
      });

      it('locks the whole note when only one field will not open', () => {
        const data = { body: 'plain body', title: seal('n1', 'title', 'T', newDataKey()) };
        expect(toRecord('n1', data, opener(KEY).open)).toMatchObject({
          body: '',
          title: SEALED_TITLE,
          locked: true,
        });
      });
    });

    describe('the cache of opened text', () => {
      const docs = [sealedDoc('n1', 'one', 'One'), sealedDoc('n2', 'two', 'Two')];
      const readAll = (opened: OpenedTexts, key: DataKey | undefined, list = docs) => {
        const open = opened.pass(() => key, UID);
        return list.map((d) => toRecord(d.id, d.data, open));
      };

      it('opens an unchanged sealed value once, however many snapshots show it', () => {
        const opened = new OpenedTexts();
        readAll(opened, KEY);
        expect(opened.tries).toBe(4);
        expect(readAll(opened, KEY).map((n) => n.title)).toEqual(['One', 'Two']);
        expect(opened.tries).toBe(4);
      });

      it('opens a changed value afresh, and keeps only what the last snapshot holds', () => {
        const opened = new OpenedTexts();
        readAll(opened, KEY);
        const changed = [sealedDoc('n1', 'one, edited', 'One'), docs[1]];
        expect(readAll(opened, KEY, changed)[0].body).toBe('one, edited');
        expect(opened.tries).toBe(6);
        // n1's old values were dropped with the snapshot that held them.
        readAll(opened, KEY);
        expect(opened.tries).toBe(8);
      });

      it('tries a value that will not open once, and starts again for a new key', () => {
        const opened = new OpenedTexts();
        readAll(opened, newDataKey());
        readAll(opened, newDataKey());
        expect(opened.tries).toBe(8);
        const wrong = newDataKey();
        readAll(opened, wrong);
        readAll(opened, wrong);
        expect(opened.tries).toBe(12);
        expect(readAll(opened, KEY).every((n) => !n.locked)).toBe(true);
      });

      it('never reads the key while every note is plain', () => {
        const opened = new OpenedTexts();
        const key = vi.fn(() => KEY);
        const open = opened.pass(key, UID);
        toRecord('n1', { body: 'plain', title: 'plain' }, open);
        expect(key).not.toHaveBeenCalled();
      });
    });

    it('shows a sealed note locked until the key arrives, then opened', () => {
      const { notes, signIn, push, key } = setup();
      signIn(UID);
      push([
        sealedDoc('n1', 'Kiln\nfire at cone 6', 'Kiln'),
        { id: 'p1', data: { body: 'Plain' } },
      ]);
      expect(notes.find('n1')).toMatchObject({ body: '', title: SEALED_TITLE, locked: true });
      expect(notes.locked('n1')).toBe(true);
      expect(notes.find('p1')).toMatchObject({ body: 'Plain', title: '' });
      key.set(KEY);
      expect(notes.find('n1')).toMatchObject({ body: 'Kiln\nfire at cone 6', title: 'Kiln' });
      expect(notes.locked('n1')).toBe(false);
      // Signed out and the key gone: locked again.
      key.set(undefined);
      expect(notes.locked('n1')).toBe(true);
    });

    it('opens a sealed note in Trash, and keeps it out of the names links resolve by', () => {
      const { notes, signIn, push, key } = setup();
      signIn(UID);
      push([
        sealedDoc('c-kiln', '', 'Kiln', { kind: 'concept', synonyms: ['Oven'] }),
        sealedDoc('t1', 'gone', 'Gone', { deletedAt: { toMillis: () => 5 } }),
      ]);
      expect(notes.trashed('t1')?.locked).toBe(true);
      // A locked concept answers to its other names, never to the placeholder.
      expect(notes.names().get('oven')).toBe('c-kiln');
      expect(notes.names().has(SEALED_TITLE.toLowerCase())).toBe(false);
      key.set(KEY);
      expect(notes.trashed('t1')?.body).toBe('gone');
      expect(notes.names().get('kiln')).toBe('c-kiln');
    });

    it('refuses every write to a locked note, whichever path it takes', async () => {
      const { notes, api, signIn, push } = setup();
      signIn(UID);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      push([
        sealedDoc('n1', 'text', 'Text', { kind: 'text', fromTemplate: 't1' }),
        sealedDoc('c-kiln', '', 'Kiln', { kind: 'concept', conceptType: 'project' }),
        sealedDoc('r1', 'recipe', 'Soup', { kind: 'recipe', source: { url: 'https://a.b/' } }),
        sealedDoc('t1', 'Journal\n', 'Journal', { kind: 'template' }),
        sealedDoc('x1', 'gone', 'Gone', { deletedAt: { toMillis: () => 5 } }),
      ]);
      const ids = ['n1', 'c-kiln', 'r1', 't1', 'x1'];
      for (const id of ids) {
        notes.save(id, 'over it', { base: '' });
        notes.settle(id, { edited: true });
        notes.settle(id);
        notes.remove(id);
        notes.setArchived(id, true);
        notes.setDeleted(id, true);
        notes.setDeleted(id, false);
        notes.setGardenHold(id, true);
        notes.setWeek(id, '2026-11-09');
        notes.setNoteMode(id, 'log');
        notes.setTemplateMode(id, 'living');
        notes.setInstructions(id, 'Ask how it went.');
        expect(notes.holdInstructions(id, 'Ask.')).toBe(false);
        expect(notes.holdName(id, 'A new name')).toBe(false);
        expect(notes.rename(id, 'A new name')).toEqual([]);
        notes.updateConcept(id, { title: 'Studio', synonyms: ['Shed'], tags: ['x'] });
        notes.updateRecipe(id, { title: 'Stew', servings: 4 });
        notes.addRecipeNote(id, 'Good with bread');
        notes.retryImport(id);
        notes.dismissImport(id);
        notes.sendToAssistant(id, 'tidy it');
        notes.unsend(id);
      }
      // A stub concept a rename would fold, and the name the fold takes.
      notes.createItem('c-other', 'Kiln');
      notes.createConcept('Kiln');
      await Promise.resolve();
      for (const id of ids) expect(writesTo(api, id)).toEqual([]);
      expect(notes.find('n1')).toBeDefined();
      for (const key of [PENDING_SAVES_KEY, PENDING_NAMES_KEY, PENDING_INSTRUCTIONS_KEY]) {
        expect(localStorage.getItem(key)).toBeNull();
      }
      warn.mockRestore();
    });

    it('still writes plain notes beside a locked one, as before', () => {
      const { notes, api, signIn, push } = setup();
      signIn(UID);
      push([sealedDoc('n1', 'text', 'Text'), { id: 'p1', data: { body: 'Plain', kind: 'text' } }]);
      notes.save('p1', 'Plain, edited', { base: 'Plain' });
      notes.save('fresh', 'A new note');
      expect(writesTo(api, 'p1')).toHaveLength(1);
      expect(writesTo(api, 'fresh')).toHaveLength(1);
    });

    it('keeps a kept save for a locked note, and replays it once the note opens', () => {
      // Typed on a load that could open the note; the page closed before
      // the server had it.
      const first = setup();
      first.key.set(KEY);
      first.signIn(UID);
      first.push([sealedDoc('n1', 'old words', 'Old')]);
      first.api.set.mockReturnValue(new Promise<void>(() => undefined));
      first.notes.save('n1', 'new words', { base: 'old words' });
      // The next load has no key yet.
      const next = setup({ reload: true });
      next.signIn(UID);
      next.push([sealedDoc('n1', 'old words', 'Old')]);
      TestBed.tick();
      expect(writesTo(next.api, 'n1')).toEqual([]);
      expect(JSON.parse(localStorage.getItem(PENDING_SAVES_KEY)!)).toMatchObject({
        n1: { value: 'new words', base: 'old words' },
      });
      // Later snapshots while it is locked change nothing.
      next.push([sealedDoc('n1', 'old words', 'Old')]);
      TestBed.tick();
      expect(writesTo(next.api, 'n1')).toEqual([]);
      next.key.set(KEY);
      TestBed.tick();
      expect(writesTo(next.api, 'n1')).toEqual([
        [
          {},
          'users/u1/notes/n1',
          expect.objectContaining({
            baseHash: noteTextHash('n1', 'old words', 'sealed', () => KEY),
          }),
          true,
        ],
      ]);
      // In the form found (2026-11-15): a sealed note's body is never
      // written plainer than it was.
      const body = writesTo(next.api, 'n1')[0][2]!['body'];
      expect(openSealedText(KEY, aadFor(UID, 'n1', 'body'), String(body))).toBe('new words');
    });

    it('names the text a save of a sealed note was written over by a keyed hash (2026-11-14)', () => {
      const { notes, api, signIn, push, key } = setup();
      key.set(KEY);
      signIn(UID);
      push([sealedDoc('n1', 'old words', 'Old'), sealedDoc('n2', 'old words', 'Old')]);
      notes.save('n1', 'new words', { base: 'old words' });
      const baseHash = String(api.set.mock.lastCall![2]['baseHash']);
      expect(isKeyedHash(baseHash)).toBe(true);
      expect(baseHash).toBe(noteTextHash('n1', 'old words', 'sealed', () => KEY));
      expect(baseHash).not.toContain(textHash('old words'));
      // The note id is bound: the same words in another note hash apart.
      notes.save('n2', 'new words', { base: 'old words' });
      expect(api.set.mock.lastCall![2]['baseHash']).not.toBe(baseHash);
    });

    it('a plain body beside a sealed title is hashed keyed too', () => {
      const { notes, api, signIn, push, key } = setup();
      key.set(KEY);
      signIn(UID);
      push([{ id: 'n1', data: { body: 'old words', title: seal('n1', 'title', 'Old') } }]);
      notes.save('n1', 'new words', { base: 'old words' });
      expect(api.set.mock.lastCall![2]['baseHash']).toBe(
        noteTextHash('n1', 'old words', 'sealed', () => KEY),
      );
    });

    it('forgets a kept save once the note opens holding someone else’s newer text', () => {
      const first = setup();
      first.key.set(KEY);
      first.signIn(UID);
      first.push([sealedDoc('n1', 'old words', 'Old')]);
      first.api.set.mockReturnValue(new Promise<void>(() => undefined));
      first.notes.save('n1', 'new words', { base: 'old words' });
      const next = setup({ reload: true });
      next.signIn(UID);
      next.push([sealedDoc('n1', 'Claude’s words', 'Old')]);
      TestBed.tick();
      expect(localStorage.getItem(PENDING_SAVES_KEY)).not.toBeNull();
      next.key.set(KEY);
      TestBed.tick();
      expect(writesTo(next.api, 'n1')).toEqual([]);
      expect(localStorage.getItem(PENDING_SAVES_KEY)).toBeNull();
    });

    it('keeps a kept name for a locked concept, and renames it once it opens', () => {
      const first = setup();
      first.key.set(KEY);
      first.signIn(UID);
      first.push([sealedDoc('c-kiln', '', 'Kiln', { kind: 'concept' })]);
      first.api.set.mockReturnValue(new Promise<void>(() => undefined));
      first.notes.rename('c-kiln', 'Big kiln');
      const next = setup({ reload: true });
      next.signIn(UID);
      next.push([sealedDoc('c-kiln', '', 'Kiln', { kind: 'concept' })]);
      TestBed.tick();
      expect(writesTo(next.api, 'c-kiln')).toEqual([]);
      expect(localStorage.getItem(PENDING_NAMES_KEY)).not.toBeNull();
      next.key.set(KEY);
      TestBed.tick();
      expect(writesTo(next.api, 'c-kiln')).toEqual([
        [
          {},
          'users/u1/notes/c-kiln',
          expect.objectContaining({ title: expect.any(String), synonyms: [expect.any(String)] }),
          true,
        ],
      ]);
      // The new title in the form found, sealed (2026-11-15).
      const title = writesTo(next.api, 'c-kiln')[0][2]!['title'];
      expect(openSealedText(KEY, aadFor(UID, 'c-kiln', 'title'), String(title))).toBe('Big kiln');
      // The old title, sealed, goes among the other names sealed (step 3d):
      // never in the clear.
      const synonyms = writesTo(next.api, 'c-kiln')[0][2]!['synonyms'] as string[];
      expect(
        synonyms.map((s) => openSealedText(KEY, aadFor(UID, 'c-kiln', 'synonyms'), s)),
      ).toEqual(['Kiln']);
    });
  });

  describe('the other sealed fields (note encryption step 3d, 2026-11-13)', () => {
    const UID = 'u1';
    const KEY = newDataKey();
    const seal = (id: string, field: SealedField, text: string, key: DataKey = KEY) =>
      sealText(key, aadFor(UID, id, field), text);
    /** The text of a sealed value; plain text throws, so a spec sees it was sealed. */
    const open = (id: string, field: SealedField, value: unknown) =>
      openSealedText(KEY, aadFor(UID, id, field), String(value));
    /** Writes to note `id` as they went out, sealed values as sent. */
    const writesTo = (api: ReturnType<typeof setup>['api'], id: string) =>
      api.set.mock.calls.filter(([, path]) => path === `users/${UID}/notes/${id}`).map(asSent);
    const opener = (key?: DataKey) => new OpenedTexts().pass(() => key, UID);

    describe('toRecord', () => {
      const doc = {
        kind: 'recipe',
        body: 'Soup',
        title: 'Soup',
        synonyms: [seal('r1', 'synonyms', 'Broth'), 'Stock', seal('r1', 'synonyms', 'Bouillon')],
        instructions: seal('r1', 'instructions', 'Keep it short.'),
        sendAsk: seal('r1', 'sendAsk', 'Tidy the method'),
        sendOutcome: seal('r1', 'sendOutcome', 'Tidied it'),
        importError: seal('r1', 'importError', 'no recipe there'),
        source: { url: 'https://a.b/soup', text: seal('r1', 'source.text', 'The page') },
      };

      it('opens every sealed field at the one decode point, a list element by element', () => {
        const note = toRecord('r1', doc, opener(KEY));
        expect(note.locked).toBeUndefined();
        expect(note).toMatchObject({
          synonyms: ['Broth', 'Stock', 'Bouillon'],
          instructions: 'Keep it short.',
          sendAsk: 'Tidy the method',
          sendOutcome: 'Tidied it',
          importError: 'no recipe there',
          source: { url: 'https://a.b/soup', text: 'The page' },
        });
        expect(JSON.stringify(note)).not.toContain('\uE000');
      });

      it('opens a list reordered, since an element is bound to the field, not its place', () => {
        const names = [seal('c1', 'synonyms', 'One'), seal('c1', 'synonyms', 'Two')];
        const note = toRecord(
          'c1',
          { kind: 'concept', synonyms: [names[1], names[0]] },
          opener(KEY),
        );
        expect(note.synonyms).toEqual(['Two', 'One']);
      });

      it('locks a note when any of them will not open, and leaves that field out', () => {
        for (const key of [undefined, newDataKey()]) {
          const note = toRecord('r1', doc, opener(key));
          expect(note.locked).toBe(true);
          expect(note.body).toBe('');
          expect(note.title).toBe(SEALED_TITLE);
          expect(note.instructions).toBeUndefined();
          expect(note.synonyms).toBeUndefined();
          expect(note.source).toEqual({ url: 'https://a.b/soup' });
          expect(JSON.stringify(note)).not.toContain('\uE000');
        }
      });

      it('will not open a name moved from another note', () => {
        const moved = { kind: 'concept', synonyms: [seal('c2', 'synonyms', 'Moved')] };
        expect(toRecord('c1', moved, opener(KEY)).locked).toBe(true);
      });

      it('leaves plain fields as they were, asking for no key', () => {
        const key = vi.fn(() => KEY);
        const plain = { kind: 'concept', synonyms: ['Oven'], instructions: 'Short.' };
        expect(toRecord('c1', plain, new OpenedTexts().pass(key, UID))).toMatchObject(plain);
        expect(key).not.toHaveBeenCalled();
      });
    });

    it('answers to a sealed other name once opened, and to none of them while locked', () => {
      const { notes, signIn, push, key } = setup();
      signIn(UID);
      push([
        {
          id: 'c-kiln',
          data: { kind: 'concept', title: 'Kiln', synonyms: [seal('c-kiln', 'synonyms', 'Oven')] },
        },
      ]);
      expect(notes.locked('c-kiln')).toBe(true);
      expect(notes.names().has('oven')).toBe(false);
      key.set(KEY);
      expect(notes.names().get('oven')).toBe('c-kiln');
      expect(notes.find('c-kiln')?.synonyms).toEqual(['Oven']);
    });

    describe('writes are sealed (the form found until 2026-11-15)', () => {
      it('instructions are written sealed, found sealed or plain', () => {
        const { notes, api, signIn, push, key } = setup();
        key.set(KEY);
        signIn(UID);
        push([
          { id: 'a', data: { kind: 'text', instructions: seal('a', 'instructions', 'Old') } },
          { id: 'b', data: { kind: 'text', instructions: 'Plain' } },
        ]);
        notes.setInstructions('a', 'New way');
        notes.setInstructions('b', 'Now sealed');
        const [[, , a]] = writesTo(api, 'a');
        expect(isSealed(a['instructions'])).toBe(true);
        expect(open('a', 'instructions', a['instructions'])).toBe('New way');
        // Plain ones are written sealed too, since 2026-11-15.
        expect(open('b', 'instructions', writesTo(api, 'b')[0][2]['instructions'])).toBe(
          'Now sealed',
        );
      });

      it('instructions beside a sealed body are sealed, as the server writes them', () => {
        const { notes, api, signIn, push, key } = setup();
        key.set(KEY);
        signIn(UID);
        push([{ id: 'a', data: { kind: 'text', body: seal('a', 'body', 'Private') } }]);
        notes.setInstructions('a', 'Tidy it');
        expect(open('a', 'instructions', writesTo(api, 'a')[0][2]['instructions'])).toBe('Tidy it');
      });

      it('other names found sealed are written sealed, each under the note and field', () => {
        const { notes, api, signIn, push, key } = setup();
        key.set(KEY);
        signIn(UID);
        push([
          {
            id: 'c-kiln',
            data: {
              kind: 'concept',
              title: 'Kiln',
              synonyms: [seal('c-kiln', 'synonyms', 'Oven')],
            },
          },
        ]);
        notes.updateConcept('c-kiln', { synonyms: ['Oven', 'Furnace'] });
        const names = writesTo(api, 'c-kiln')[0][2]['synonyms'] as string[];
        expect(names.every(isSealed)).toBe(true);
        expect(names.map((n) => open('c-kiln', 'synonyms', n))).toEqual(['Oven', 'Furnace']);
      });

      it('an ask found sealed is cut to its limit as plain text, then sealed', () => {
        const { notes, api, signIn, push, key } = setup();
        key.set(KEY);
        signIn(UID);
        push([{ id: 'a', data: { kind: 'text', sendAsk: seal('a', 'sendAsk', 'Earlier') } }]);
        notes.sendToAssistant('a', 'x'.repeat(SEND_ASK_MAX + 50));
        const [[, , update]] = writesTo(api, 'a');
        expect(open('a', 'sendAsk', update['sendAsk'])).toBe('x'.repeat(SEND_ASK_MAX));
        expect(update['sendOutcome']).toBe(REMOVED);
      });

      it('a plain ask is still cut to its limit as plain text, and written sealed', () => {
        const { notes, api, signIn, push } = setup({ key: KEY });
        signIn(UID);
        push([{ id: 'a', data: { kind: 'text' } }]);
        notes.sendToAssistant('a', 'y'.repeat(SEND_ASK_MAX + 50));
        expect(open('a', 'sendAsk', writesTo(api, 'a')[0][2]['sendAsk'])).toBe(
          'y'.repeat(SEND_ASK_MAX),
        );
      });

      it('a new link for a recipe writes its source text back as stored, never as read', () => {
        const { notes, api, signIn, push, key } = setup();
        key.set(KEY);
        signIn(UID);
        const text = seal('r1', 'source.text', 'The page');
        push([
          {
            id: 'r1',
            data: { kind: 'recipe', title: 'Soup', source: { url: 'https://a.b/', text } },
          },
        ]);
        notes.updateRecipe('r1', { url: 'https://c.d/' });
        expect(writesTo(api, 'r1')[0][2]['source']).toEqual({ url: 'https://c.d/', text });
      });
    });

    it('keeps kept instructions for a note whose sealed instructions do not open, and writes them sealed once it opens', () => {
      const first = setup();
      first.key.set(KEY);
      first.signIn(UID);
      const docs = [
        { id: 'a', data: { kind: 'text', instructions: seal('a', 'instructions', 'Old') } },
      ];
      first.push(docs);
      first.api.set.mockReturnValue(new Promise<void>(() => undefined));
      first.notes.setInstructions('a', 'Typed before the page closed');
      // The next load has no key yet: the note is locked, the write waits.
      const next = setup({ reload: true });
      next.signIn(UID);
      next.push(docs);
      TestBed.tick();
      expect(next.notes.locked('a')).toBe(true);
      expect(writesTo(next.api, 'a')).toEqual([]);
      expect(JSON.parse(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)!)).toMatchObject({
        a: { value: 'Typed before the page closed' },
      });
      next.key.set(KEY);
      TestBed.tick();
      const [[, , update]] = writesTo(next.api, 'a');
      expect(open('a', 'instructions', update['instructions'])).toBe(
        'Typed before the page closed',
      );
    });
  });

  describe('always sealed (note encryption, 2026-11-15)', () => {
    const UID = 'u1';
    const KEY = newDataKey();
    const open = (id: string, field: SealedField, value: unknown) =>
      openSealedText(KEY, aadFor(UID, id, field), String(value));
    const note = (id: string, body: string, more: Record<string, unknown> = {}) => ({
      id,
      data: { body, title: body, titleSource: 'words', kind: 'text', ...more },
    });
    type T = ReturnType<typeof setup>;
    /** What went out to note `id`, as sent: sealed. */
    const sentTo = (t: T, id: string) =>
      t.sent.filter((w) => w.path === `users/${UID}/notes/${id}`).map((w) => w.data);
    /** Everything every write sent, as one string. */
    const everything = (t: T) => JSON.stringify(t.sent);
    const held = () =>
      Object.values(JSON.parse(localStorage.getItem(PENDING_SAVES_KEY) ?? '{}')).filter(
        (e) => !!(e as { held?: unknown }).held,
      );

    it('with its key: a save goes straight into the cache, sealed, nothing held (the everyday path)', () => {
      const t = setup({ key: KEY });
      t.signIn(UID);
      t.push([note('a', 'Buy milk')]);
      t.notes.save('a', 'Buy milk\n- eggs', { base: 'Buy milk' });
      t.notes.save('fresh', 'Plumber on Tuesday');
      // Written at once, in the same call, with no tick or await between.
      expect(t.api.set).toHaveBeenCalledTimes(2);
      const [edit] = sentTo(t, 'a');
      expect(open('a', 'body', edit['body'])).toBe('Buy milk\n- eggs');
      expect(edit['baseHash']).toBe(noteTextHash('a', 'Buy milk', 'sealed', () => KEY));
      expect(open('fresh', 'body', sentTo(t, 'fresh')[0]['body'])).toBe('Plumber on Tuesday');
      expect(t.notes.waitingForKey()).toBe(false);
      expect(t.notes.heldForKey('fresh')).toBe(false);
      expect(held()).toEqual([]);
      expect(everything(t)).not.toMatch(/Plumber|eggs/);
    });

    it('with its key: offline on a first load from the cache, and after a reload, written at once', () => {
      const t = setup({ key: KEY });
      t.online.set(false);
      t.signIn(UID);
      t.push([], { fromCache: true });
      t.notes.save('fresh', 'Written on the train');
      expect(t.api.set).toHaveBeenCalledTimes(1);
      expect(open('fresh', 'body', sentTo(t, 'fresh')[0]['body'])).toBe('Written on the train');
      const next = setup({ reload: true, key: KEY });
      next.online.set(false);
      next.signIn(UID);
      next.push([note('fresh', 'Written on the train')], { fromCache: true });
      next.notes.save('fresh', 'Written on the train, and more', { base: 'Written on the train' });
      expect(sentTo(next, 'fresh')).toHaveLength(1);
      expect(open('fresh', 'body', sentTo(next, 'fresh')[0]['body'])).toBe(
        'Written on the train, and more',
      );
      expect(next.notes.waitingForKey()).toBe(false);
      expect(held()).toEqual([]);
    });

    it('a new note is born sealed, body and title, nothing in the clear', () => {
      const t = setup({ key: KEY });
      t.signIn(UID);
      t.push([]);
      t.notes.save('fresh', 'Plumber on Tuesday\nbring the key');
      const [[, , , merge]] = t.api.set.mock.calls;
      expect(merge).toBe(false);
      const [data] = sentTo(t, 'fresh');
      expect(isSealed(data['body'])).toBe(true);
      expect(isSealed(data['title'])).toBe(true);
      expect(open('fresh', 'body', data['body'])).toBe('Plumber on Tuesday\nbring the key');
      expect(open('fresh', 'title', data['title'])).toBe('Plumber on Tuesday');
      expect(everything(t)).not.toContain('Plumber');
    });

    it('an edit to a plain note (read as it is) writes it sealed, its base keyed', () => {
      const t = setup({ key: KEY });
      t.signIn(UID);
      t.push([note('a', 'Buy milk')]);
      expect(t.notes.find('a')).toMatchObject({ body: 'Buy milk' });
      t.notes.save('a', 'Buy milk\n- eggs', { base: 'Buy milk' });
      const [data] = sentTo(t, 'a');
      expect(open('a', 'body', data['body'])).toBe('Buy milk\n- eggs');
      expect(open('a', 'title', data['title'])).toBe('Buy milk');
      expect(isKeyedHash(data['baseHash'])).toBe(true);
      expect(everything(t)).not.toContain('eggs');
      expect(everything(t)).not.toContain(textHash('Buy milk'));
    });

    it('every writer’s note text goes out sealed, at the one seam', () => {
      const t = setup({ key: KEY });
      t.signIn(UID);
      t.push([note('a', 'Buy milk', { kind: 'template' })]);
      t.notes.setInstructions('a', 'Ask how the day went.');
      t.notes.create('t2', 'Journal\n\n## Today', { kind: 'template' });
      const recipe = t.notes.createRecipe('Sourdough')!;
      const clipped = t.notes.clip('Ash makes a runny celadon.', 'Wood ash glazes', {
        feedItemId: 'i1',
      });
      expect(open('a', 'instructions', sentTo(t, 'a')[0]['instructions'])).toBe(
        'Ask how the day went.',
      );
      expect(open('t2', 'body', sentTo(t, 't2')[0]['body'])).toBe('Journal\n\n## Today');
      expect(open(recipe, 'title', sentTo(t, recipe)[0]['title'])).toBe('Sourdough');
      expect(open(clipped, 'title', sentTo(t, clipped)[0]['title'])).toBe('Wood ash glazes');
      for (const words of ['Ask how', 'Journal', 'Sourdough', 'celadon', 'Wood ash']) {
        expect(everything(t)).not.toContain(words);
      }
    });

    it('a sealed note stays sealed when written, and opens again', () => {
      const t = setup({ key: KEY });
      t.signIn(UID);
      t.push([
        {
          id: 's',
          data: {
            kind: 'text',
            body: sealText(KEY, aadFor(UID, 's', 'body'), 'Sealed words'),
            title: sealText(KEY, aadFor(UID, 's', 'title'), 'Sealed words'),
            titleSource: 'words',
          },
        },
      ]);
      t.notes.save('s', 'Sealed words, more', { base: 'Sealed words' });
      const [edit] = sentTo(t, 's');
      expect(open('s', 'body', edit['body'])).toBe('Sealed words, more');
      expect(open('s', 'title', edit['title'])).toBe('Sealed words, more');
      expect(isKeyedHash(edit['baseHash'])).toBe(true);
    });

    it('no key: typing is held on the device, never sent, then written sealed when the key comes', () => {
      const t = setup({ key: undefined });
      t.signIn(UID);
      t.push([note('a', 'Buy milk')]);
      t.notes.save('fresh', 'Plumber on Tuesday');
      t.notes.save('a', 'Buy milk\n- eggs', { base: 'Buy milk' });
      t.notes.save('a', 'Buy milk\n- eggs\n- bread', { base: 'Buy milk\n- eggs' });
      expect(t.api.set).not.toHaveBeenCalled();
      expect(t.notes.waitingForKey()).toBe(true);
      expect(t.notes.heldForKey('fresh')).toBe(true);
      expect(t.notes.heldSave('fresh')?.value).toBe('Plumber on Tuesday');
      expect(t.notes.exists('fresh')).toBe(true);
      const kept = JSON.parse(localStorage.getItem(PENDING_SAVES_KEY)!);
      expect(kept).toMatchObject({
        fresh: { value: 'Plumber on Tuesday', held: {} },
        // The base is the text the first held save was typed over.
        a: { value: 'Buy milk\n- eggs\n- bread', held: { base: 'Buy milk' } },
      });
      // Nothing about a held new note is written before its text.
      t.notes.settle('fresh', { edited: true });
      expect(t.api.set).not.toHaveBeenCalled();
      t.key.set(KEY);
      TestBed.tick();
      const [fresh] = sentTo(t, 'fresh');
      expect(fresh).toMatchObject({ kind: 'text', archived: false });
      expect(open('fresh', 'body', fresh['body'])).toBe('Plumber on Tuesday');
      const [edit] = sentTo(t, 'a');
      expect(open('a', 'body', edit['body'])).toBe('Buy milk\n- eggs\n- bread');
      expect(edit['baseHash']).toBe(noteTextHash('a', 'Buy milk', 'sealed', () => KEY));
      expect(everything(t)).not.toContain('Plumber');
      expect(everything(t)).not.toContain('bread');
      expect(t.notes.waitingForKey()).toBe(false);
    });

    it('held words survive a reload, stay held without the key, and are written sealed after', () => {
      const first = setup({ key: undefined });
      first.signIn(UID);
      first.push([]);
      first.notes.save('fresh', 'Typed on a new device');
      const next = setup({ reload: true, key: undefined });
      next.signIn(UID);
      // Before the notes load, the editor can show them.
      expect(next.notes.heldForKey('fresh')).toBe(true);
      next.push([]);
      TestBed.tick();
      expect(next.api.set).not.toHaveBeenCalled();
      expect(next.notes.heldSave('fresh')?.value).toBe('Typed on a new device');
      next.key.set(KEY);
      TestBed.tick();
      expect(open('fresh', 'body', sentTo(next, 'fresh')[0]['body'])).toBe('Typed on a new device');
    });

    it('a save held by the app before this change (for the switch) is replayed once the key is here', () => {
      // As the code of 2026-11-15 kept a save while the switch was unheard.
      localStorage.clear();
      localStorage.setItem(
        PENDING_SAVES_KEY,
        JSON.stringify({ old: { uid: UID, value: 'Held for the switch', base: null, held: {} } }),
      );
      localStorage.setItem('goblin.sealNotes.u1', 'on');
      const t = setup({ reload: true, key: KEY });
      t.signIn(UID);
      expect(t.notes.heldSave('old')?.value).toBe('Held for the switch');
      t.push([], { fromCache: true });
      TestBed.tick();
      expect(open('old', 'body', sentTo(t, 'old')[0]['body'])).toBe('Held for the switch');
      t.push([]);
      TestBed.tick();
      expect(sentTo(t, 'old')).toHaveLength(1);
      expect(t.notes.waitingForKey()).toBe(false);
    });

    it('an existing note’s held save survives a reload as the text shown, then is written over its base (review on #276)', () => {
      const first = setup({ key: undefined });
      first.signIn(UID);
      first.push([note('a', 'Buy milk')]);
      first.notes.save('a', 'Buy milk\n- eggs', { base: 'Buy milk' });
      // The next save is typed over words only this device has: its base stays the server's.
      first.notes.save('a', 'Buy milk\n- eggs\n- bread', { base: 'Buy milk\n- eggs' });
      const next = setup({ reload: true, key: undefined });
      next.signIn(UID);
      next.push([note('a', 'Buy milk')]);
      TestBed.tick();
      // Held, not lost, and what the editor is to show, over its base.
      expect(next.notes.heldSave('a')).toEqual({
        value: 'Buy milk\n- eggs\n- bread',
        base: 'Buy milk',
      });
      expect(next.api.set).not.toHaveBeenCalled();
      // Another device wrote meanwhile; the editor merged it in and saves over that.
      next.push([note('a', 'Shopping: Buy milk')]);
      next.notes.save('a', 'Shopping: Buy milk\n- eggs\n- bread', { base: 'Shopping: Buy milk' });
      expect(next.notes.heldSave('a')?.base).toBe('Shopping: Buy milk');
      next.key.set(KEY);
      TestBed.tick();
      const [data] = sentTo(next, 'a');
      expect(open('a', 'body', data['body'])).toBe('Shopping: Buy milk\n- eggs\n- bread');
      expect(data['baseHash']).toBe(noteTextHash('a', 'Shopping: Buy milk', 'sealed', () => KEY));
    });

    it('a held save whose note went to Trash goes into the trashed note; one gone for good stays gone', () => {
      const first = setup({ key: undefined });
      first.signIn(UID);
      first.push([note('a', 'Buy milk'), note('b', 'Old')]);
      first.notes.save('a', 'Buy milk\n- eggs', { base: 'Buy milk' });
      first.notes.save('b', 'Old, more', { base: 'Old' });
      const next = setup({ reload: true, key: KEY });
      next.signIn(UID);
      next.push([note('a', 'Buy milk', { deletedAt: { toMillis: () => CLOCK - 1000 } })]);
      TestBed.tick();
      expect(open('a', 'body', sentTo(next, 'a')[0]['body'])).toBe('Buy milk\n- eggs');
      expect(sentTo(next, 'b')).toEqual([]);
      expect(next.notes.heldSave('b')).toBeUndefined();
    });

    it('a new note held, then a reload with the key: written from the cache at once, once (share journey)', () => {
      const first = setup({ key: undefined });
      first.signIn(UID);
      first.push([], { fromCache: true });
      first.notes.save('fresh', 'Seeds\nwhat if seeds could talk');
      expect(first.api.set).not.toHaveBeenCalled();
      // The page reloads before the server has answered anything; the key is on the device now.
      const next = setup({ reload: true, key: KEY });
      next.signIn(UID);
      next.push([], { fromCache: true });
      TestBed.tick();
      // Written into the cache now: no server snapshot needed, no typing.
      const [[, , data, merge]] = next.api.set.mock.calls;
      expect(merge).toBe(false);
      expect(data).toMatchObject({ kind: 'text', body: 'Seeds\nwhat if seeds could talk' });
      expect(next.notes.waitingForKey()).toBe(false);
      // And not written twice when the server's snapshot comes.
      next.push([]);
      TestBed.tick();
      expect(sentTo(next, 'fresh')).toHaveLength(1);
    });

    it('a new note held is written as soon as the key comes, before the server’s notes', () => {
      const t = setup({ key: undefined });
      t.signIn(UID);
      t.push([], { fromCache: true });
      t.notes.save('fresh', 'Seeds');
      expect(t.api.set).not.toHaveBeenCalled();
      t.key.set(KEY);
      TestBed.tick();
      expect(sentTo(t, 'fresh')).toHaveLength(1);
    });

    it('an existing note’s held save still waits for the server’s snapshot, which says it is there', () => {
      const first = setup({ key: undefined });
      first.signIn(UID);
      first.push([note('a', 'Buy milk')]);
      first.notes.save('a', 'Buy milk\n- eggs', { base: 'Buy milk' });
      const next = setup({ reload: true, key: KEY });
      next.signIn(UID);
      next.push([note('a', 'Buy milk')], { fromCache: true });
      TestBed.tick();
      expect(sentTo(next, 'a')).toEqual([]);
      next.push([note('a', 'Buy milk')]);
      TestBed.tick();
      expect(next.api.set.mock.calls[0][2]).toMatchObject({ body: 'Buy milk\n- eggs' });
    });

    it('held words for a note in Trash wait for the server’s snapshot too (review on #277)', () => {
      const trashedNote = () => {
        const n = note('a', 'Buy milk');
        return { ...n, data: { ...n.data, deletedAt: { toMillis: () => CLOCK - 1000 } } };
      };
      const first = setup({ key: undefined });
      first.signIn(UID);
      first.push([trashedNote()]);
      first.notes.save('a', 'Buy milk\n- eggs', { base: 'Buy milk' });
      const next = setup({ reload: true, key: KEY });
      next.signIn(UID);
      next.push([trashedNote()], { fromCache: true });
      TestBed.tick();
      // Not written as a new note from the cache: that would replace it.
      expect(sentTo(next, 'a')).toEqual([]);
    });

    it('a fresh device offline, then back: held words reach the server whichever comes first, key or notes (e2e capture offline)', () => {
      for (const order of ['key first', 'notes first'] as const) {
        TestBed.resetTestingModule();
        const t = setup({ key: undefined });
        t.signIn(UID);
        // Offline: the notes come from the cache only, and no key.
        t.push([], { fromCache: true });
        t.notes.save('fresh', 'Written on the train');
        expect(t.api.set).not.toHaveBeenCalled();
        expect(t.notes.waitingForKey()).toBe(true);
        if (order === 'key first') {
          t.key.set(KEY);
          TestBed.tick();
          // A new note goes from the cache as soon as the key is here.
          expect(sentTo(t, 'fresh')).toHaveLength(1);
          t.push([]);
        } else {
          t.push([]);
          TestBed.tick();
          expect(t.api.set).not.toHaveBeenCalled();
          t.key.set(KEY);
        }
        TestBed.tick();
        expect(sentTo(t, 'fresh'), order).toHaveLength(1);
        expect(t.api.set.mock.calls[0]?.[2], order).toMatchObject({
          body: 'Written on the train',
        });
        expect(t.notes.waitingForKey(), order).toBe(false);
        expect(t.notes.heldForKey('fresh'), order).toBe(false);
      }
    });

    it('no key: a rename and instructions wait on the device, then go sealed', () => {
      const t = setup({ key: undefined });
      t.signIn(UID);
      t.push([note('c-kiln', '', { kind: 'concept', title: 'Kiln', titleSource: 'user' })]);
      t.api.set.mockClear();
      t.notes.rename('c-kiln', 'Big kiln');
      t.notes.setInstructions('c-kiln', 'Firing notes short.');
      expect(t.api.set).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem(PENDING_NAMES_KEY)!)).toMatchObject({
        'c-kiln': { value: 'Big kiln' },
      });
      t.key.set(KEY);
      TestBed.tick();
      const writes = sentTo(t, 'c-kiln');
      const titled = writes.find((d) => 'title' in d)!;
      expect(open('c-kiln', 'title', titled['title'])).toBe('Big kiln');
      const told = writes.find((d) => 'instructions' in d)!;
      expect(open('c-kiln', 'instructions', told['instructions'])).toBe('Firing notes short.');
      expect(everything(t)).not.toContain('Big kiln');
    });

    it('no key: a write with no note text in it goes out as ever, archive included', () => {
      const t = setup({ key: undefined });
      t.signIn(UID);
      t.push([note('a', 'Buy milk')]);
      t.notes.setArchived('a', true);
      t.notes.setDeleted('a', true);
      expect(sentTo(t, 'a')).toEqual([
        expect.objectContaining({ archived: true }),
        expect.objectContaining({ deletedAt: expect.anything() }),
      ]);
      expect(TestBed.inject(KeyWaitNotice).refused()).toBe(false);
    });

    it('no key: a write that would carry text is refused, and the page is told', async () => {
      const t = setup({ key: undefined });
      t.signIn(UID);
      t.push([]);
      const notice = TestBed.inject(KeyWaitNotice);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      t.notes.create('t2', 'Journal\n\n## Today', { kind: 'template' });
      expect(t.api.set).not.toHaveBeenCalled();
      expect(notice.refused()).toBe(true);
      // The key arrives: the line goes.
      t.key.set(KEY);
      TestBed.tick();
      expect(notice.refused()).toBe(false);
    });

    it('no key: a kept rename waits without telling the page it was not done', () => {
      const t = setup({ key: undefined });
      t.signIn(UID);
      t.push([note('c-kiln', '', { kind: 'concept', title: 'Kiln', titleSource: 'user' })]);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      t.notes.rename('c-kiln', 'Big kiln');
      t.notes.setInstructions('c-kiln', 'Short.');
      expect(TestBed.inject(KeyWaitNotice).refused()).toBe(false);
    });
  });
  describe('a public copy (2026-11-26)', () => {
    const glaze = {
      id: 'n1',
      data: {
        kind: 'text',
        body: '- [ ] Two parts [[Feldspar]] @goblin',
        title: 'Glaze',
        archived: false,
      },
    };
    const gratin = {
      id: 'r1',
      data: {
        kind: 'recipe',
        title: 'Gratin',
        body: '## Ingredients\n\n- potatoes',
        source: { url: 'https://recipes.example/gratin', text: 'the page' },
        tags: ['dinner'],
        archived: false,
      },
    };
    const SHARE = 'AbCdEfGhIjKlMnOpQrStUvWxYz012-_9';
    /** Every batch committed, as its writes. */
    const batches = (api: ReturnType<typeof setup>['api']) =>
      api.commit.mock.calls.map((c) => c[1]);
    /** Writes to a share's document outside a batch: there must be none. */
    const loose = (api: ReturnType<typeof setup>['api']) => [
      ...api.set.mock.calls.filter((c) => String(c[1]).startsWith('shares/')),
      ...api.remove.mock.calls.filter((c) => String(c[1]).startsWith('shares/')),
    ];

    it('writes a plain copy at a new id and the id on the note, in one batch', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([glaze]);
      const id = notes.share('n1')!;
      expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(batches(api)).toEqual([
        [
          {
            path: `shares/${id}`,
            data: {
              owner: 'u1',
              noteId: 'n1',
              kind: 'note',
              title: 'Glaze',
              // Its link as words; the assistant's mark gone.
              body: '- [ ] Two parts Feldspar',
              sharedAt: 'SERVER_TIME',
              updatedAt: 'SERVER_TIME',
            },
          },
          // The note learns its share id, and nothing else of it changes.
          { path: 'users/u1/notes/n1', data: { shareId: id }, merge: true },
        ],
      ]);
      // Never sealed: the copy is public by its nature.
      const copy = batches(api)[0][0].data!;
      expect(isSealed(copy['body'])).toBe(false);
      expect(isSealed(copy['title'])).toBe(false);
      expect(loose(api)).toEqual([]);
    });

    it('shares a recipe with its source link, and nothing else of the note', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([gratin]);
      notes.share('r1');
      expect(batches(api)[0][0].data).toEqual({
        owner: 'u1',
        noteId: 'r1',
        kind: 'recipe',
        title: 'Gratin',
        body: '## Ingredients\n\n- potatoes',
        source: 'https://recipes.example/gratin',
        sharedAt: 'SERVER_TIME',
        updatedAt: 'SERVER_TIME',
      });
    });

    it('reads a note’s share id, and lists the shared notes', () => {
      const { notes, signIn, push } = setup();
      signIn('u1');
      push([{ id: 'n1', data: { ...glaze.data, shareId: SHARE } }, gratin]);
      expect(notes.find('n1')?.shareId).toBe(SHARE);
      expect(notes.find('r1')?.shareId).toBeUndefined();
      expect(notes.shared().map((n) => n.id)).toEqual(['n1']);
      push([{ id: 'n1', data: { ...glaze.data, shareId: 'nope' } }]);
      expect(notes.find('n1')?.shareId).toBeUndefined();
    });

    it('updates the copy only when asked, from the note as it is now', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([{ id: 'n1', data: { ...glaze.data, body: 'Three parts', shareId: SHARE } }]);
      expect(batches(api)).toHaveLength(0);
      notes.updateShare('n1');
      expect(batches(api)).toEqual([
        [
          {
            path: `shares/${SHARE}`,
            data: {
              kind: 'note',
              title: 'Glaze',
              body: 'Three parts',
              source: REMOVED,
              updatedAt: 'SERVER_TIME',
            },
            merge: true,
          },
        ],
      ]);
    });

    it('stops in one batch: the copy deleted, the note forgetting it; again is a new link', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([{ id: 'n1', data: { ...glaze.data, shareId: SHARE } }]);
      notes.stopShare('n1');
      expect(batches(api)).toEqual([
        [
          { path: `shares/${SHARE}` },
          { path: 'users/u1/notes/n1', data: { shareId: REMOVED }, merge: true },
        ],
      ]);
      push([glaze]);
      const again = notes.share('n1')!;
      expect(again).not.toBe(SHARE);
      push([{ id: 'n1', data: { ...glaze.data, shareId: again } }]);
      expect(notes.share('n1')).toBeUndefined();
      expect(loose(api)).toEqual([]);
    });

    it('says a write waits until the server has it, across a reload (review of #343)', async () => {
      const t = setup();
      t.signIn('u1');
      t.push([{ id: 'n1', data: { ...glaze.data, shareId: SHARE } }]);
      t.offline();
      t.notes.stopShare('n1');
      expect(t.notes.sharesWaiting()[SHARE]).toEqual(
        expect.objectContaining({ noteId: 'n1', title: 'Glaze', op: 'stop' }),
      );
      // A reload while offline still says so.
      const r = setup({ reload: true });
      expect(r.notes.sharesWaiting()[SHARE]).toEqual(expect.objectContaining({ op: 'stop' }));
      // Back, the server has every write: it is said no more.
      r.signIn('u1');
      r.push([glaze]);
      await Promise.resolve();
      await Promise.resolve();
      expect(r.api.synced).toHaveBeenCalled();
      expect(r.notes.sharesWaiting()).toEqual({});
    });

    it('stops waiting once the batch reaches the server', async () => {
      const { notes, signIn, push } = setup();
      signIn('u1');
      push([glaze]);
      const id = notes.share('n1')!;
      expect(notes.sharesWaiting()[id]?.op).toBe('share');
      await Promise.resolve();
      await Promise.resolve();
      expect(notes.sharesWaiting()).toEqual({});
    });

    it('Trash stops it in the same batch as the note; Restore does not bring it back', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([{ id: 'n1', data: { ...glaze.data, shareId: SHARE } }]);
      notes.setDeleted('n1', true);
      const [batch] = batches(api);
      expect(batch[0]).toEqual({ path: `shares/${SHARE}` });
      expect(batch[1]).toEqual({
        path: 'users/u1/notes/n1',
        data: expect.objectContaining({ deletedAt: { ms: CLOCK }, shareId: REMOVED }),
        merge: true,
      });
      push([{ id: 'n1', data: { ...glaze.data, deletedAt: { toMillis: () => CLOCK } } }]);
      notes.setDeleted('n1', false);
      expect(api.set.mock.lastCall![2]).not.toHaveProperty('shareId');
      expect(batches(api)).toHaveLength(1);
    });

    it('a note removed for good takes its copy with it, in one batch', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([{ id: 'n1', data: { ...glaze.data, shareId: SHARE } }]);
      notes.remove('n1');
      expect(batches(api)).toEqual([[{ path: `shares/${SHARE}` }, { path: 'users/u1/notes/n1' }]]);
    });

    it('a locked note’s stop deletes the copy alone; the server clears the note', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      const other = newDataKey();
      const body = sealText(other, aadFor('u1', 's1', 'body'), 'secret');
      const title = sealText(other, aadFor('u1', 's1', 'title'), 'secret');
      push([{ id: 's1', data: { kind: 'text', body, title, archived: false, shareId: SHARE } }]);
      expect(notes.find('s1')?.locked).toBe(true);
      notes.stopShare('s1');
      expect(batches(api)).toEqual([[{ path: `shares/${SHARE}` }]]);
    });

    it('archiving leaves it shared', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([{ id: 'n1', data: { ...glaze.data, shareId: SHARE } }]);
      notes.setArchived('n1', true);
      expect(batches(api)).toEqual([]);
      expect(api.set.mock.lastCall![2]).not.toHaveProperty('shareId');
    });

    it('refuses what cannot be shared, saying why', () => {
      const { notes, api, signIn, push } = setup();
      signIn('u1');
      push([
        glaze,
        { id: 'c-kiln', data: { kind: 'concept', title: 'Kiln', body: 'x', archived: false } },
        { id: 'e', data: { kind: 'text', title: '', body: '  ', archived: false } },
        {
          id: 'big',
          data: { kind: 'text', title: 'Big', body: 'x'.repeat(200_001), archived: false },
        },
      ]);
      expect(notes.shareRefusal('c-kiln')).toBe('Only notes and recipes can be shared.');
      expect(notes.shareRefusal('e')).toBe('There is nothing in it to share yet.');
      expect(notes.shareRefusal('gone')).toBe('This note is not saved yet.');
      expect(notes.shareRefusal('big')).toBe(
        'It is too long to share as a link: a shared copy holds at most 200,000 characters, ' +
          'and this has 200,001.',
      );
      expect(notes.shareRefusal('n1')).toBeUndefined();
      expect(notes.share('c-kiln')).toBeUndefined();
      expect(notes.share('big')).toBeUndefined();
      const other = newDataKey();
      const sealedBody = sealText(other, aadFor('u1', 's1', 'body'), 'secret');
      const sealedTitle = sealText(other, aadFor('u1', 's1', 'title'), 'secret');
      push([
        { id: 's1', data: { kind: 'text', body: sealedBody, title: sealedTitle, archived: false } },
      ]);
      expect(notes.shareRefusal('s1')).toBe(
        'This note is sealed and its key is not on this device yet.',
      );
      expect(notes.share('s1')).toBeUndefined();
      expect(batches(api)).toHaveLength(0);
    });

    it('a body nested past any stack is refused calmly, never thrown (review of #343)', () => {
      const { notes, signIn, push } = setup();
      signIn('u1');
      push([
        {
          id: 'd',
          data: { kind: 'text', title: 'Deep', body: `${'> '.repeat(5_000)}x`, archived: false },
        },
      ]);
      expect(() => notes.shareRefusal('d')).not.toThrow();
    });
  });
});
