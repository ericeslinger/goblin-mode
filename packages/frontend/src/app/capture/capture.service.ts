import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { shouldStartFreshNote } from '@goblin/schema';
import { NotesService } from '../notes/notes.service';
import { LocalStore } from '../platform/local-store';
import { NOW } from '../platform/platform';

/** What the editor should show: a note id and the text to load. */
export interface OpenNote {
  id: string;
  text: string;
}

interface LastSeen {
  hiddenAt: number;
  noteId: string;
}

interface PendingDraft {
  id: string;
  body: string;
}

export const LAST_SEEN_KEY = 'goblin.lastSeen';
export const PENDING_DRAFT_KEY = 'goblin.pendingDraft';
export const SAVE_DELAY_MS = 300;

/**
 * The capture loop (DESIGN.md, Client): which note is open, saving it as
 * it is typed, and the rules for launch.
 *
 * - Away 5 minutes or more (or first run): a fresh note. Otherwise the
 *   note that was open.
 * - Typing is saved 300 ms after it pauses, and at once when the app is
 *   hidden. Before sign-in it is kept as a pending draft on the device
 *   and written once the user is known, so nothing is lost.
 * - A note left empty is deleted when you leave it.
 */
@Injectable({ providedIn: 'root' })
export class CaptureService {
  private readonly notes = inject(NotesService);
  private readonly store = inject(LocalStore);
  private readonly now = inject(NOW);

  /** The note in the editor; `text` changes only when a note is opened. */
  readonly open = signal<OpenNote>({ id: '', text: '' });

  private body = '';
  private dirty = false;
  /** True until the user types in the open note. */
  private untouched = true;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    const draft = this.store.get<PendingDraft>(PENDING_DRAFT_KEY);
    if (draft?.body) {
      // Unsaved text from before sign-in always wins: never lose it.
      this.show({ id: draft.id, text: draft.body });
      this.untouched = false;
    } else {
      const seen = this.store.get<LastSeen>(LAST_SEEN_KEY);
      this.show(
        shouldStartFreshNote(seen?.hiddenAt, this.now()) || !seen?.noteId
          ? { id: this.notes.newId(), text: '' }
          : { id: seen.noteId, text: '' },
      );
    }

    // A resumed note's text arrives with the first snapshot; load it
    // unless the user has already started typing.
    effect(() => {
      const list = this.notes.notes();
      untracked(() => {
        if (!this.untouched) return;
        const note = list.find((n) => n.id === this.open().id);
        if (note && note.body !== this.open().text) this.show({ id: note.id, text: note.body });
      });
    });

    // Once the user is known, write any pending draft.
    effect(() => {
      if (!this.notes.loaded()) return;
      untracked(() => {
        const pending = this.store.get<PendingDraft>(PENDING_DRAFT_KEY);
        if (!pending) return;
        if (pending.body.trim()) this.notes.save(pending.id, pending.body);
        this.store.remove(PENDING_DRAFT_KEY);
      });
    });

    const doc = inject(DOCUMENT);
    const onVisibility = () => (doc.hidden ? this.leave() : this.returned());
    const onPageHide = () => this.leave();
    doc.addEventListener('visibilitychange', onVisibility);
    doc.defaultView?.addEventListener('pagehide', onPageHide);
    inject(DestroyRef).onDestroy(() => {
      doc.removeEventListener('visibilitychange', onVisibility);
      doc.defaultView?.removeEventListener('pagehide', onPageHide);
      clearTimeout(this.timer);
    });
  }

  /** The editor reports every change here. */
  onText(text: string): void {
    this.body = text;
    this.dirty = true;
    this.untouched = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  /** Writes any unsaved typing now. */
  flush(): void {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    this.dirty = false;
    const { id } = this.open();
    if (!this.notes.ready) {
      if (this.body.trim()) this.store.set(PENDING_DRAFT_KEY, { id, body: this.body });
      else this.store.remove(PENDING_DRAFT_KEY);
      return;
    }
    if (this.body.trim()) this.notes.save(id, this.body);
    else if (this.notes.exists(id)) this.notes.remove(id);
  }

  /** Opens another note (from Previous notes, Browse or a link). */
  openNote(id: string): void {
    if (id === this.open().id) return;
    this.closeCurrent();
    this.show({ id, text: this.notes.find(id)?.body ?? '' });
  }

  /** Starts a fresh, empty note. */
  newNote(): void {
    this.closeCurrent();
    this.show({ id: this.notes.newId(), text: '' });
  }

  /** The app is being hidden: save, tidy, and stamp the time. */
  leave(): void {
    this.flush();
    this.store.set(LAST_SEEN_KEY, { hiddenAt: this.now(), noteId: this.open().id });
  }

  /** The app is visible again: after 5 minutes away, a fresh note. */
  returned(): void {
    const seen = this.store.get<LastSeen>(LAST_SEEN_KEY);
    if (shouldStartFreshNote(seen?.hiddenAt, this.now())) this.newNote();
  }

  private closeCurrent(): void {
    this.flush();
    const { id } = this.open();
    // Only a note emptied by typing here is deleted: an untouched one may
    // simply not have loaded yet, and must never be removed.
    if (!this.untouched && !this.body.trim() && this.notes.exists(id)) this.notes.remove(id);
  }

  private show(note: OpenNote): void {
    this.open.set(note);
    this.body = note.text;
    this.dirty = false;
    this.untouched = true;
  }
}
