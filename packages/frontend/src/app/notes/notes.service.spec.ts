import { textHash } from '@mossgoblin/schema';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { fakeFirebase } from '../testing/fakes';
import { ONLINE } from '../platform/platform';
import {
  NOTES_API,
  type NotesApi,
  NotesService,
  PENDING_CONCEPTS_KEY,
  PENDING_MOODS_KEY,
} from './notes.service';

function setup() {
  localStorage.clear();
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
    removeField: () => 'REMOVED',
  } satisfies NotesApi;
  const online = signal(true);
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: AuthService, useValue: { user } },
      { provide: NOTES_API, useValue: api },
      { provide: ONLINE, useValue: () => online() },
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
    push: (docs: Parameters<typeof push>[0]) => push(docs),
    user,
    online,
  };
}

describe('NotesService', () => {
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
