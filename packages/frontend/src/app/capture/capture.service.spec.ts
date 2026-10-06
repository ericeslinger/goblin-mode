import { TestBed } from '@angular/core/testing';
import { NotesService } from '../notes/notes.service';
import { FakeNotes, noteRecord } from '../testing/fakes';
import { NOW } from '../platform/platform';
import { CaptureService, LAST_SEEN_KEY, PENDING_DRAFT_KEY, SAVE_DELAY_MS } from './capture.service';

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
    expect(capture.open()).toEqual({ id: 'n1', text: 'groceries' });
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
    expect(notes.save).toHaveBeenCalledExactlyOnceWith('new1', 'eggs and milk');
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
    expect(notes.save).toHaveBeenCalledWith('new1', 'half a thought');
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

  it('never deletes a resumed note whose text has not loaded yet', () => {
    const { capture, notes } = setup({ [LAST_SEEN_KEY]: { hiddenAt: clock, noteId: 'n1' } });
    notes.ready = true;
    notes.written.add('n1');
    capture.newNote();
    expect(notes.remove).not.toHaveBeenCalled();
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
