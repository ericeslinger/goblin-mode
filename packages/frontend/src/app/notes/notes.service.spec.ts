import { RESTORE_SUFFIX, textHash } from '@mossgoblin/schema';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { fakeFirebase } from '../testing/fakes';
import { NOW, ONLINE } from '../platform/platform';
import {
  NOTES_API,
  type NotesApi,
  NotesService,
  PENDING_CONCEPTS_KEY,
  PENDING_INSTRUCTIONS_KEY,
  PENDING_MOODS_KEY,
  PENDING_NAMES_KEY,
  PENDING_SAVES_KEY,
} from './notes.service';

/** The device's clock in these specs. */
const CLOCK = Date.parse('2026-11-09T12:00:00Z');

/** `reload` keeps this device's storage, as a page loaded again does. */
function setup({ reload = false }: { reload?: boolean } = {}) {
  if (reload) TestBed.resetTestingModule();
  else localStorage.clear();
  const user = signal<User | null | undefined>(undefined);
  let push: Parameters<NotesApi['listen']>[2] = () => undefined;
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
    serverTime: () => 'SERVER_TIME',
    timestamp: (ms: number) => ({ ms }),
    removeField: () => 'REMOVED',
  } satisfies NotesApi;
  const online = signal(true);
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: { user } },
      { provide: NOTES_API, useValue: api },
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

    it('holds nothing for a note that is not a template', () => {
      const { notes, signIn, push } = setup();
      signIn('u1');
      push([{ id: 'n1', data: { body: 'x', kind: 'text' } }]);
      expect(notes.holdInstructions('n1', 'Ask')).toBe(false);
      expect(localStorage.getItem(PENDING_INSTRUCTIONS_KEY)).toBeNull();
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
        baseHash: textHash('one'),
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
        sendOutcome: 'REMOVED',
        // Sent by Eric himself now, not on arrival (#214).
        sentOnArrival: 'REMOVED',
      },
      true,
    );
    notes.sendToAssistant('n1', ' ');
    expect(api.set.mock.lastCall![2]).toMatchObject({ sendState: 'queued', sendAsk: 'REMOVED' });
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
      api.set.mock.calls.filter(([, , data]) => data['deletedAt'] === 'REMOVED');

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
            deletedAt: 'REMOVED',
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
    expect(api.set.mock.lastCall![2]).toMatchObject({ parent: 'REMOVED', projectKind: 'content' });
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
    expect(api.set.mock.lastCall![2]).toMatchObject({ servings: 'REMOVED' });
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
    expect(api.set.mock.lastCall![2]).toMatchObject({ stage: 'REMOVED' });
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
        deletedAt: 'REMOVED',
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

  it('records the text a save was written over, or that it is not known', () => {
    const { notes, api, signIn, push } = setup();
    signIn('u1');
    push([{ id: 'n1', data: { body: 'one', archived: false } }]);
    notes.save('n1', 'one two', { base: 'one' });
    expect(api.set.mock.lastCall![2]['baseHash']).toBe(textHash('one'));
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
});
