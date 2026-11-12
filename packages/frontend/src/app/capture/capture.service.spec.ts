import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import {
  NOTES_API,
  type NoteRecord,
  type NotesApi,
  NotesService,
  PENDING_SAVES_KEY,
  SEALED_TITLE,
} from '../notes/notes.service';
import { FakeNotes, fakeFirebase, noteRecord } from '../testing/fakes';
import { NOW, ONLINE } from '../platform/platform';
import {
  CaptureService,
  LAST_SEEN_KEY,
  PENDING_DRAFT_KEY,
  PENDING_SETTLE_KEY,
  SAVE_DELAY_MS,
} from './capture.service';

const MIN = 60_000;
let clock = 1_000_000;

function setup(stored: Record<string, unknown> = {}) {
  localStorage.clear();
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, JSON.stringify(v));
  const notes = new FakeNotes();
  TestBed.configureTestingModule({
    providers: [
      { provide: NotesService, useValue: notes },
      { provide: NOW, useValue: () => clock },
    ],
  });
  const capture = TestBed.inject(CaptureService);
  TestBed.tick();
  return { capture, notes };
}

const note = noteRecord;

describe('CaptureService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens a fresh note on first run', () => {
    const { capture } = setup();
    expect(capture.open()).toEqual({ id: 'new1', text: '' });
  });

  it('resumes the last note within five minutes, loading its text when it arrives', () => {
    const { capture, notes } = setup({
      [LAST_SEEN_KEY]: { hiddenAt: clock - 4 * MIN, noteId: 'n1' },
    });
    expect(capture.open().id).toBe('n1');
    notes.signIn([note('n1', 'groceries')]);
    TestBed.tick();
    expect(capture.open()).toMatchObject({ id: 'n1', text: 'groceries' });
  });

  it('merges a change made elsewhere into what is being typed, and saves both (#37)', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n1', 'List\n- [ ] apples\n- [ ] kale')]);
    capture.openNote('n1');
    capture.onText('List\n- [x] apples\n- [ ] kale');
    // Claude adds an item before the tick is saved.
    notes.notes.set([note('n1', 'List\n- [ ] apples\n- [ ] kale\n- [ ] oats')]);
    TestBed.tick();
    expect(capture.open()).toEqual({
      id: 'n1',
      text: 'List\n- [x] apples\n- [ ] kale\n- [ ] oats',
      base: 'List\n- [x] apples\n- [ ] kale',
    });
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(notes.save).toHaveBeenLastCalledWith(
      'n1',
      'List\n- [x] apples\n- [ ] kale\n- [ ] oats',
      {
        // Written over the text merged in, which the server has.
        base: 'List\n- [ ] apples\n- [ ] kale\n- [ ] oats',
      },
    );
  });

  it('takes a change from the list view: shown in the editor, saved, or kept at once', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n1', '- [ ] limes\n- [x] rice')]);
    capture.openNote('n1');
    capture.replace('- [x] limes\n- [x] rice');
    expect(capture.open()).toEqual({
      id: 'n1',
      text: '- [x] limes\n- [x] rice',
      base: '- [ ] limes\n- [x] rice',
    });
    expect(capture.current()).toBe('- [x] limes\n- [x] rice');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(notes.save).toHaveBeenLastCalledWith('n1', '- [x] limes\n- [x] rice', {
      base: '- [ ] limes\n- [x] rice',
    });
    capture.replace('List', { keep: true });
    expect(notes.save).toHaveBeenLastCalledWith('n1', 'List', {
      base: '- [x] limes\n- [x] rice',
      keep: true,
    });
  });

  it('saves the last tick before a keep, so History keeps the ticked list', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n1', '- [ ] limes')]);
    capture.openNote('n1');
    capture.replace('- [x] limes');
    // Done shopping within the save delay.
    capture.replace('List', { keep: true });
    expect(notes.save.mock.calls).toEqual([
      ['n1', '- [x] limes', { base: '- [ ] limes' }],
      ['n1', 'List', { base: '- [x] limes', keep: true }],
    ]);
  });

  it('shows a change made elsewhere when nothing was typed, without saving it back', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n1', 'one')]);
    capture.openNote('n1');
    notes.notes.set([note('n1', 'one\ntwo')]);
    TestBed.tick();
    expect(capture.open().text).toBe('one\ntwo');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(notes.save).not.toHaveBeenCalled();
  });

  it('does not merge its own saved text back in', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n1', 'one')]);
    capture.openNote('n1');
    capture.onText('one two');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    const shown = capture.open();
    notes.notes.set([note('n1', 'one two')]);
    TestBed.tick();
    expect(capture.open()).toBe(shown);
  });

  it('ignores a late snapshot of its own earlier save, keeping the edit since', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n1', 'title')]);
    capture.openNote('n1');
    const old = 'title\n- the site and conconpanion app';
    const fixed = 'title\n- the site and conpanion app';
    capture.onText(old);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    capture.onText(fixed);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    capture.onText(`${fixed}\n- basic modules`);
    // The first save comes back after the second (2026-10-07): merging
    // it would put the typo back and lose the fix.
    notes.notes.set([{ ...note('n1', old), deviceId: 'here' }]);
    TestBed.tick();
    expect(capture.current()).toBe(`${fixed}\n- basic modules`);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(notes.save).toHaveBeenLastCalledWith('n1', `${fixed}\n- basic modules`, {
      base: fixed,
    });
    // A change from elsewhere still merges in.
    notes.notes.set([
      note('n1', `title\n- [[armature]]\n- the site and conpanion app\n- basic modules`),
    ]);
    TestBed.tick();
    expect(capture.current()).toBe(
      'title\n- [[armature]]\n- the site and conpanion app\n- basic modules',
    );
  });

  it('merges an earlier text of its own when another writer put it back', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n1', 'List')]);
    capture.openNote('n1');
    capture.onText('List\n- [ ] milk');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    capture.onText('List\n- [x] milk');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    // The laptop unticks it: the text this phone saved first, but news.
    notes.notes.set([{ ...note('n1', 'List\n- [ ] milk'), deviceId: 'laptop' }]);
    TestBed.tick();
    expect(capture.current()).toBe('List\n- [ ] milk');
  });

  it('keeps typing done before a resumed note arrived, and the note too', () => {
    const { capture, notes } = setup({
      [LAST_SEEN_KEY]: { hiddenAt: clock - 4 * MIN, noteId: 'n1' },
    });
    capture.onText('call the bank');
    notes.signIn([note('n1', 'groceries\n- eggs')]);
    TestBed.tick();
    expect(capture.open().text).toBe('call the bank\ngroceries\n- eggs');
  });

  it('opens a fresh note after five minutes away', () => {
    const { capture } = setup({ [LAST_SEEN_KEY]: { hiddenAt: clock - 5 * MIN, noteId: 'n1' } });
    expect(capture.open().id).toBe('new1');
  });

  it('saves typing after a pause, and only non-empty text', () => {
    const { capture, notes } = setup();
    notes.signIn();
    capture.onText('');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(notes.save).not.toHaveBeenCalled();
    capture.onText('eggs');
    capture.onText('eggs and milk');
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1);
    expect(notes.save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notes.save).toHaveBeenCalledExactlyOnceWith('new1', 'eggs and milk', { base: '' });
  });

  it('keeps typing before sign-in as a pending draft, then writes it', () => {
    const { capture, notes } = setup();
    capture.onText('before sign-in');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(JSON.parse(localStorage.getItem(PENDING_DRAFT_KEY)!)).toEqual({
      id: 'new1',
      body: 'before sign-in',
    });
    notes.signIn();
    TestBed.tick();
    expect(notes.save).toHaveBeenCalledWith('new1', 'before sign-in');
    expect(localStorage.getItem(PENDING_DRAFT_KEY)).toBeNull();
  });

  it('keeps typing as a draft until the notes have loaded', () => {
    const { capture, notes } = setup({ [LAST_SEEN_KEY]: { hiddenAt: clock, noteId: 'n1' } });
    // Signed in, but the first snapshot has not arrived.
    capture.onText('more');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(notes.save).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PENDING_DRAFT_KEY)!)).toEqual({
      id: 'n1',
      body: 'more',
    });
  });

  it('never writes a pending draft over newer text', () => {
    const { capture, notes } = setup({ [PENDING_DRAFT_KEY]: { id: 'd1', body: 'old' } });
    notes.signIn();
    capture.onText('old and newer');
    capture.flush();
    TestBed.tick();
    expect(notes.save).toHaveBeenCalledExactlyOnceWith('d1', 'old and newer', { base: '' });
    expect(localStorage.getItem(PENDING_DRAFT_KEY)).toBeNull();
  });

  it('reopens a pending draft on launch rather than lose it', () => {
    const { capture } = setup({
      [PENDING_DRAFT_KEY]: { id: 'd1', body: 'unsaved' },
      [LAST_SEEN_KEY]: { hiddenAt: clock - 60 * MIN, noteId: 'n1' },
    });
    expect(capture.open()).toEqual({ id: 'd1', text: 'unsaved' });
  });

  it('saves and stamps the time when the app is hidden, then a fresh note after 5 minutes', () => {
    const { capture, notes } = setup();
    notes.signIn();
    capture.onText('half a thought');
    capture.leave();
    expect(notes.save).toHaveBeenCalledWith('new1', 'half a thought', { base: '' });
    expect(JSON.parse(localStorage.getItem(LAST_SEEN_KEY)!)).toEqual({
      hiddenAt: clock,
      noteId: 'new1',
    });
    clock += 2 * MIN;
    capture.returned();
    expect(capture.open().id).toBe('new1');
    clock += 3 * MIN;
    capture.returned();
    expect(capture.open().id).toBe('new2');
  });

  it('deletes a note emptied by typing when you leave it', () => {
    const { capture, notes } = setup();
    notes.signIn();
    capture.onText('oops');
    capture.flush();
    capture.onText('');
    capture.newNote();
    expect(notes.remove).toHaveBeenCalledWith('new1');
  });

  it('opens a note just made here with its text, before the list has it', () => {
    const { capture, notes } = setup();
    notes.signIn([]);
    capture.openNote('e1', 'Journal\nMood:');
    expect(capture.open()).toEqual({ id: 'e1', text: 'Journal\nMood:' });
  });

  it('removes an entry left as its template’s skeleton, and keeps one written in (#40)', () => {
    const { capture, notes } = setup();
    const template = 'Feelings\nMoods: \n\n## Instructions for Claude\nQuote him.';
    notes.signIn([
      { ...noteRecord('t1', template), kind: 'template' },
      { ...noteRecord('t2', 'List'), kind: 'template', templateMode: 'living' },
      { ...noteRecord('e1', 'Feelings\nMoods:'), fromTemplate: 't1' },
      { ...noteRecord('e2', 'Feelings\nMoods:'), fromTemplate: 't1' },
      { ...noteRecord('l1', 'List'), fromTemplate: 't2' },
    ]);
    capture.openNote('e1');
    capture.newNote();
    expect(notes.remove).toHaveBeenCalledWith('e1');
    capture.openNote('e2');
    capture.onText('Feelings\nMoods: [[calm]]');
    capture.newNote();
    // A living template's note is its one note, kept however bare.
    capture.openNote('l1');
    capture.newNote();
    expect(notes.remove).toHaveBeenCalledOnce();
  });

  it('keeps a template emptied by typing', () => {
    const { capture, notes } = setup();
    notes.signIn([{ ...noteRecord('t1', 'Journal'), kind: 'template' }]);
    capture.openNote('t1');
    capture.onText('');
    capture.newNote();
    expect(notes.remove).not.toHaveBeenCalled();
    expect(notes.save).toHaveBeenCalledWith('t1', '', { base: 'Journal' });
  });

  it('never deletes a resumed note whose text has not loaded yet', () => {
    const { capture, notes } = setup({ [LAST_SEEN_KEY]: { hiddenAt: clock, noteId: 'n1' } });
    notes.loaded.set(true);
    notes.written.add('n1');
    capture.newNote();
    expect(notes.remove).not.toHaveBeenCalled();
  });

  it('restores an earlier version: saves typing first, writes it as a restore, opens it', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n1', 'current')]);
    capture.openNote('n1');
    capture.onText('current, edited');
    capture.restore('n1', 'older words');
    expect(notes.save.mock.calls).toEqual([
      ['n1', 'current, edited', { base: 'current' }],
      ['n1', 'older words', { restore: true }],
    ]);
    expect(capture.open()).toEqual({ id: 'n1', text: 'older words' });
    // A snapshot that still has the newer text does not load over it.
    notes.notes.set([note('n1', 'current, edited')]);
    TestBed.tick();
    expect(capture.open().text).toBe('older words');
  });

  it('settles the note it leaves: New, or another note', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n1', 'old note'), note('n2', 'other note')]);
    capture.onText('typed here');
    capture.newNote();
    expect(notes.settle).toHaveBeenLastCalledWith('new1', { edited: true });
    capture.openNote('n1');
    expect(notes.settle).toHaveBeenLastCalledWith('new2', { edited: false });
    capture.openNote('n2');
    expect(notes.settle).toHaveBeenLastCalledWith('n1', { edited: false });
  });

  it('plants the concepts a typed note links to when it is left', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n1', 'read only')]);
    capture.onText('see [[Pottery]]');
    capture.newNote();
    expect(notes.plantConcepts).toHaveBeenCalledExactlyOnceWith('see [[Pottery]]');
    capture.openNote('n1');
    capture.openHome();
    expect(notes.plantConcepts).toHaveBeenCalledOnce();
  });

  it('never deletes a concept for having no text', () => {
    const { capture, notes } = setup();
    notes.signIn([{ ...note('c-kiln', ''), title: 'Kiln', kind: 'concept' }, note('n1', 'x')]);
    capture.openNote('c-kiln');
    capture.onText('a');
    capture.flush();
    capture.onText('');
    capture.flush();
    expect(notes.save).toHaveBeenLastCalledWith('c-kiln', '', { base: 'a' });
    capture.onText('b');
    capture.onText('');
    capture.openNote('n1');
    expect(notes.remove).not.toHaveBeenCalled();
  });

  it('does not settle a note emptied by typing; it deletes it', () => {
    const { capture, notes } = setup();
    notes.signIn();
    capture.onText('oops');
    capture.flush();
    capture.onText('');
    capture.newNote();
    expect(notes.remove).toHaveBeenCalledWith('new1');
    expect(notes.settle).not.toHaveBeenCalled();
  });

  it('after five minutes away, settles the note left then, once notes load', () => {
    const { notes } = setup({ [LAST_SEEN_KEY]: { hiddenAt: clock - 5 * MIN, noteId: 'n1' } });
    expect(notes.settle).not.toHaveBeenCalled();
    notes.signIn([note('n1', 'left five minutes ago')]);
    TestBed.tick();
    expect(notes.settle).toHaveBeenCalledExactlyOnceWith('n1', { edited: false });
    expect(localStorage.getItem(PENDING_SETTLE_KEY)).toBeNull();
  });

  it('holds a settle made before the notes load, and writes it once they do', () => {
    const { capture, notes } = setup({ [LAST_SEEN_KEY]: { hiddenAt: clock, noteId: 'n1' } });
    capture.onText('typed before sign-in');
    capture.newNote();
    expect(notes.settle).not.toHaveBeenCalled();
    notes.signIn([note('n1', 'typed before sign-in')]);
    TestBed.tick();
    expect(notes.save).toHaveBeenCalledWith('n1', 'typed before sign-in');
    expect(notes.settle).toHaveBeenCalledExactlyOnceWith('n1', { edited: true });
    // The draft is written before the settle, so the title sees it.
    expect(notes.save.mock.invocationCallOrder[0]).toBeLessThan(
      notes.settle.mock.invocationCallOrder[0],
    );
  });

  it('settles on returning after five minutes, through New', () => {
    const { capture, notes } = setup();
    notes.signIn();
    capture.onText('written before lunch');
    capture.leave();
    clock += 5 * MIN;
    capture.returned();
    expect(notes.settle).toHaveBeenCalledWith('new1', { edited: true });
    expect(capture.open().id).toBe('new2');
  });

  it('keeps the capture note: other notes come and go, New replaces it', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n1', 'elsewhere')]);
    expect(capture.home()).toBe('new1');
    capture.onText('captured');
    capture.openNote('n1');
    expect(capture.home()).toBe('new1');
    capture.openHome();
    expect(capture.open().id).toBe('new1');
    capture.newNote();
    expect(capture.home()).toBe('new2');
    capture.openNote('n1');
    capture.openHome();
    expect(capture.open().id).toBe('new2');
  });

  it('reopens a note held only as a pending draft with that draft', () => {
    const { capture, notes } = setup({ [LAST_SEEN_KEY]: { hiddenAt: clock, noteId: 'h1' } });
    capture.onText('typed before the notes load');
    capture.flush();
    capture.openNote('x1');
    capture.openHome();
    expect(capture.open()).toEqual({ id: 'h1', text: 'typed before the notes load' });
    capture.onText('typed before the notes load, and more');
    capture.flush();
    notes.signIn();
    TestBed.tick();
    expect(notes.save).toHaveBeenCalledWith('h1', 'typed before the notes load, and more');
  });

  it('says when coming back starts a fresh note', () => {
    const { capture, notes } = setup();
    notes.signIn();
    capture.leave();
    clock += 2 * MIN;
    capture.returned();
    expect(capture.renewed()).toBe(0);
    clock += 5 * MIN;
    capture.returned();
    expect(capture.renewed()).toBe(1);
  });

  it('opens another note with its text', () => {
    const { capture, notes } = setup();
    notes.signIn([note('n9', 'older note')]);
    capture.openNote('n9');
    expect(capture.open()).toEqual({ id: 'n9', text: 'older note' });
  });

  it('listens for the page being hidden', () => {
    const { capture } = setup();
    const leave = vi.spyOn(capture, 'leave');
    window.dispatchEvent(new Event('pagehide'));
    expect(leave).toHaveBeenCalled();
  });
});

/**
 * The capture loop over the real NotesService, the cache's write never
 * acknowledged (#200): a page loaded again keeps this device's storage,
 * and the next instances must find the words there.
 */
describe('CaptureService, when the page goes before the cache has the text (#200)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type Doc = { id: string; data: Record<string, unknown> };
  function load({ reload = false }: { reload?: boolean } = {}) {
    if (reload) TestBed.resetTestingModule();
    else localStorage.clear();
    const user = signal<User | null | undefined>(undefined);
    let push: (docs: Doc[], fromCache: boolean) => void = () => undefined;
    const api = {
      listen: vi.fn((_db, _path, next) => {
        push = next;
        return vi.fn();
      }),
      // The cache never takes it in: the page goes first.
      set: vi.fn(
        (_db: unknown, _path: string, _data: Record<string, unknown>, _merge: boolean) =>
          new Promise<void>(() => undefined),
      ),
      createIfAbsent: vi.fn(() => Promise.resolve(true)),
      remove: vi.fn(() => Promise.resolve()),
      serverTime: () => 'SERVER_TIME',
      timestamp: (ms: number) => ({ ms }),
      removeField: () => 'REMOVED',
    } satisfies NotesApi;
    TestBed.configureTestingModule({
      providers: [
        { provide: FIREBASE, useValue: fakeFirebase(true) },
        { provide: AuthService, useValue: { user } },
        { provide: NOTES_API, useValue: api },
        { provide: ONLINE, useValue: () => true },
        { provide: NOW, useValue: () => clock },
      ],
    });
    const capture = TestBed.inject(CaptureService);
    TestBed.tick();
    const signIn = (docs: Doc[]) => {
      user.set({ uid: 'u1' } as User);
      TestBed.tick();
      push(docs, false);
      TestBed.tick();
    };
    const bodies = () =>
      api.set.mock.calls
        .filter(([, , d]) => 'body' in d)
        .map(([, path, d, merge]) => ({
          path,
          body: d['body'],
          merge,
        }));
    return { capture, signIn, bodies };
  }
  const text = (id: string, body: string): Doc => ({ id, data: { body, kind: 'text' } });

  it('a new note typed and the page closed within the save delay', () => {
    const first = load();
    first.signIn([]);
    const id = first.capture.open().id;
    first.capture.onText('a thought on the bus');
    window.dispatchEvent(new Event('pagehide'));
    expect(first.bodies()).toEqual([
      { path: `users/u1/notes/${id}`, body: 'a thought on the bus', merge: false },
    ]);
    expect(localStorage.getItem(PENDING_DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_SAVES_KEY)).not.toBeNull();

    const next = load({ reload: true });
    // Reopened at once: the note comes back where it was.
    expect(next.capture.open().id).toBe(id);
    next.signIn([]);
    expect(next.bodies()).toEqual([
      { path: `users/u1/notes/${id}`, body: 'a thought on the bus', merge: false },
    ]);
  });

  it('an edit of an existing note, saved after the pause, then the page closed', () => {
    const first = load();
    first.signIn([text('n1', 'groceries')]);
    first.capture.openNote('n1');
    first.capture.onText('groceries\n- limes');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(first.bodies()).toEqual([
      { path: 'users/u1/notes/n1', body: 'groceries\n- limes', merge: true },
    ]);
    window.dispatchEvent(new Event('pagehide'));

    const next = load({ reload: true });
    next.signIn([text('n1', 'groceries')]);
    expect(next.bodies()).toEqual([
      { path: 'users/u1/notes/n1', body: 'groceries\n- limes', merge: true },
    ]);
  });

  it('typing before the notes load: the draft, then kept until acknowledged', () => {
    const first = load();
    const id = first.capture.open().id;
    first.capture.onText('before sign-in');
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(localStorage.getItem(PENDING_DRAFT_KEY)!)).toEqual({
      id,
      body: 'before sign-in',
    });
    // The notes load and the draft is written; the page goes at once.
    first.signIn([]);
    expect(first.bodies()).toEqual([
      { path: `users/u1/notes/${id}`, body: 'before sign-in', merge: false },
    ]);
    expect(localStorage.getItem(PENDING_DRAFT_KEY)).toBeNull();

    const next = load({ reload: true });
    next.signIn([]);
    expect(next.bodies()).toEqual([
      { path: `users/u1/notes/${id}`, body: 'before sign-in', merge: false },
    ]);
  });

  describe('a sealed note this device cannot open (note encryption step 3a)', () => {
    /** As NotesService reads a note it cannot open: placeholders. */
    const locked = (id: string, more: Partial<NoteRecord> = {}): NoteRecord => ({
      ...note(id, ''),
      title: SEALED_TITLE,
      locked: true,
      ...more,
    });
    const draft = () => JSON.parse(localStorage.getItem(PENDING_DRAFT_KEY) ?? 'null');

    it('keeps typing from before the notes loaded on the device, and merges it in once it opens', () => {
      const { capture, notes } = setup({
        [LAST_SEEN_KEY]: { hiddenAt: clock - 4 * MIN, noteId: 'n1' },
      });
      capture.onText('typed before it loaded');
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      notes.signIn([locked('n1')]);
      TestBed.tick();
      // Locked: never written over, never merged with the placeholder.
      expect(capture.current()).toBe('typed before it loaded');
      capture.onText('typed before it loaded, and more');
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      capture.leave();
      expect(notes.save).not.toHaveBeenCalled();
      expect(draft()).toEqual({
        id: 'n1',
        body: 'typed before it loaded, and more',
        forLocked: true,
      });

      // The key arrives: the note opens, and the typing merges into it.
      notes.notes.set([note('n1', 'The note as it was')]);
      TestBed.tick();
      const [id, text, opts] = notes.save.mock.calls[0];
      expect(id).toBe('n1');
      expect(text).toContain('typed before it loaded, and more');
      expect(text).toContain('The note as it was');
      expect(opts).toEqual({ base: 'The note as it was' });
      expect(capture.open().text).toBe(text);
      expect(draft()).toBeNull();
    });

    it('waits with a draft for a note that is not open, and keeps it past other edits', () => {
      const { capture, notes } = setup({
        [PENDING_DRAFT_KEY]: { id: 'n1', body: 'kept words' },
      });
      notes.signIn([locked('n1'), note('p1', 'plain')]);
      TestBed.tick();
      capture.openNote('p1');
      capture.onText('plain, edited');
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      expect(notes.save).toHaveBeenCalledWith('p1', 'plain, edited', { base: 'plain' });
      expect(draft()).toEqual({ id: 'n1', body: 'kept words', forLocked: true });
      // Opened, merged into the note's text and written; the draft goes.
      notes.notes.set([note('n1', 'the text'), note('p1', 'plain, edited')]);
      TestBed.tick();
      expect(notes.save).toHaveBeenLastCalledWith('n1', expect.stringContaining('kept words'), {
        base: 'the text',
      });
      expect(notes.save.mock.lastCall?.[1]).toContain('the text');
      expect(draft()).toBeNull();
    });

    it('merges a draft kept for a locked note even after a reload, with the key now here (review on #262)', () => {
      // A load ago this draft waited for n1, locked then; this load has the key at once.
      const { notes } = setup({
        [PENDING_DRAFT_KEY]: { id: 'n1', body: 'a fragment', forLocked: true },
      });
      notes.signIn([note('n1', 'the whole text')]);
      TestBed.tick();
      const [id, text, opts] = notes.save.mock.calls[0];
      expect(id).toBe('n1');
      expect(text).toContain('a fragment');
      expect(text).toContain('the whole text');
      expect(opts).toEqual({ base: 'the whole text' });
      expect(draft()).toBeNull();
    });

    it('never removes, settles or restores over a locked note left or opened', () => {
      const { capture, notes } = setup();
      notes.signIn([locked('n1', { kind: 'text' })]);
      TestBed.tick();
      capture.openNote('n1');
      expect(capture.open()).toEqual({ id: 'n1', text: '' });
      capture.newNote();
      capture.restore('n1', 'an old version');
      capture.leave();
      expect(notes.remove).not.toHaveBeenCalled();
      // Only the fresh note it was opened from is settled.
      expect(notes.settle.mock.calls.map(([id]) => id)).not.toContain('n1');
      expect(notes.save).not.toHaveBeenCalled();
    });

    it('changes nothing for plain notes', () => {
      const { capture, notes } = setup({ [PENDING_DRAFT_KEY]: { id: 'n1', body: 'draft' } });
      notes.signIn([note('n1', 'stored')]);
      TestBed.tick();
      // As before step 3a: the draft is written as it was typed.
      expect(notes.save).toHaveBeenCalledWith('n1', 'draft');
      expect(draft()).toBeNull();
      expect(capture.open().id).toBe('n1');
    });
  });
});
