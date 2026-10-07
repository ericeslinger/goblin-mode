import { TestBed } from '@angular/core/testing';
import { NotesService } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { NOW } from '../platform/platform';
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
