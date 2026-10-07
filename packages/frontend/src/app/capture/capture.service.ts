import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { merge3, shouldStartFreshNote } from '@mossgoblin/schema';
import { NotesService } from '../notes/notes.service';
import { LocalStore } from '../platform/local-store';
import { NOW } from '../platform/platform';

/**
 * What the editor should show: a note id and its text. With `base`, the
 * text is a change merged in from elsewhere into what was typed up to
 * `base`; the editor keeps anything typed since (#37).
 */
export interface OpenNote {
  id: string;
  text: string;
  base?: string;
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
export const PENDING_SETTLE_KEY = 'goblin.pendingSettle';
export const SAVE_DELAY_MS = 300;

/**
 * The capture loop (DESIGN.md, Client): which note is open, saving it as
 * it is typed, and the rules for launch.
 *
 * - Away 5 minutes or more (or first run): a fresh note. Otherwise the
 *   note that was open.
 * - Typing is saved 300 ms after it pauses, and at once when the app is
 *   hidden. Until the user is known and their notes have loaded, it is
 *   kept as a pending draft on the device and written after, so nothing
 *   is lost and an unseen note is never overwritten.
 * - A note left empty is deleted when you leave it.
 */
@Injectable({ providedIn: 'root' })
export class CaptureService {
  private readonly notes = inject(NotesService);
  private readonly store = inject(LocalStore);
  private readonly now = inject(NOW);

  /** The note in the editor; `text` changes when a note is opened or merged into. */
  readonly open = signal<OpenNote>({ id: '', text: '' });
  /**
   * The capture note, the one `/` shows: chosen at launch by the
   * five-minute rule, and replaced by New. Other notes have their own
   * URL, `/n/<id>`.
   */
  readonly home = signal('');
  /** Bumped when coming back after five minutes starts a fresh note. */
  readonly renewed = signal(0);

  private readonly typed = signal('');
  /** The open note's text as it is now, typing included. */
  readonly current = this.typed.asReadonly();
  private get body(): string {
    return untracked(this.typed);
  }
  private set body(text: string) {
    this.typed.set(text);
  }
  /**
   * The open note's text as the server last had it, from here: what was
   * loaded, saved, or merged in. Typing since is merged against it.
   */
  private synced = '';
  /** The text a restore just replaced, until a newer snapshot arrives. */
  private replaced?: { id: string; text: string };
  private dirty = false;
  /** True until the user types in the open note. */
  private untouched = true;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    const draft = this.store.get<PendingDraft>(PENDING_DRAFT_KEY);
    if (draft?.body) {
      // Unsaved text from before sign-in always wins: never lose it. It
      // was typed against unknown text, so the note merges in whole.
      this.show({ id: draft.id, text: draft.body });
      this.synced = '';
      this.untouched = false;
    } else {
      const seen = this.store.get<LastSeen>(LAST_SEEN_KEY);
      const fresh = shouldStartFreshNote(seen?.hiddenAt, this.now()) || !seen?.noteId;
      // A fresh note after five minutes away settles the one left then.
      if (fresh && seen?.noteId) this.store.set(PENDING_SETTLE_KEY, seen.noteId);
      const resume = fresh ? undefined : seen?.noteId;
      this.show({ id: resume ?? this.notes.newId(), text: '' });
    }
    this.home.set(this.open().id);

    // The open note changed elsewhere (another device, Claude), or a
    // resumed note's text arrived: merge it with anything typed since
    // the last sync, so neither side's text is lost (#37).
    effect(() => {
      const list = this.notes.notes();
      untracked(() => {
        const { id } = this.open();
        const note = list.find((n) => n.id === id);
        if (note) this.merge(id, note.body);
      });
    });

    // Once the user is known, write any pending settle and draft.
    effect(() => {
      if (!this.notes.loaded()) return;
      untracked(() => {
        // The draft first, so the settle's title sees the final text.
        const pending = this.store.get<PendingDraft>(PENDING_DRAFT_KEY);
        if (pending) {
          if (pending.body.trim()) this.notes.save(pending.id, pending.body);
          this.store.remove(PENDING_DRAFT_KEY);
        }
        const settle = this.store.get<string>(PENDING_SETTLE_KEY);
        if (settle) {
          this.notes.settle(settle, { edited: settle === pending?.id && !!pending.body.trim() });
          this.store.remove(PENDING_SETTLE_KEY);
        }
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

  private merge(id: string, remote: string): void {
    if (remote === this.synced) return;
    if (this.replaced?.id === id && this.replaced.text === remote) return;
    this.replaced = undefined;
    const local = this.body;
    const merged = local === this.synced ? remote : merge3(this.synced, local, remote);
    this.synced = remote;
    this.body = merged;
    this.open.set({ id, text: merged, base: local });
    if (merged !== remote) {
      // Local typing survived the merge: the server needs it too.
      this.dirty = true;
      this.untouched = false;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    }
  }

  /**
   * A change made outside the editor (the list view, #39): shown in the
   * editor, keeping anything typed there, and saved. `keep` saves at
   * once as its own writer, so History keeps the text it replaced.
   */
  replace(text: string, { keep = false }: { keep?: boolean } = {}): void {
    const { id } = this.open();
    // What was typed or ticked first is saved first, so a keep keeps it.
    if (keep && this.dirty) this.flush();
    const before = this.body;
    if (text === before) return;
    this.body = text;
    this.dirty = true;
    this.untouched = false;
    this.open.set({ id, text, base: before });
    if (keep) this.flush({ keep: true });
    else {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    }
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
  flush({ keep = false }: { keep?: boolean } = {}): void {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    this.dirty = false;
    const { id } = this.open();
    if (!this.notes.ready) {
      if (this.body.trim()) this.store.set(PENDING_DRAFT_KEY, { id, body: this.body });
      else this.store.remove(PENDING_DRAFT_KEY);
      return;
    }
    // This text is newer than any pending draft, which must not land
    // on top of it later.
    this.store.remove(PENDING_DRAFT_KEY);
    const base = this.synced;
    this.synced = this.body;
    // A concept is never deleted for having no text: its name, type and
    // other names are what it is (review on #66). Nor is a template.
    if (this.body.trim() || this.isKept(id))
      this.notes.save(id, this.body, keep ? { base, keep } : { base });
    else if (this.notes.exists(id)) this.notes.remove(id);
  }

  /** Kinds that stay when emptied: concepts and templates. */
  private isKept(id: string): boolean {
    const kind = this.notes.find(id)?.kind;
    return kind === 'concept' || kind === 'template';
  }

  /** Opens another note (from Previous notes, Browse, a link or a template). */
  openNote(id: string, known?: string): void {
    if (id === this.open().id) return;
    this.closeCurrent();
    // Typing held on the device before the notes load is this note's
    // newest text: show it, never an empty note that would replace it.
    const draft = this.store.get<PendingDraft>(PENDING_DRAFT_KEY);
    if (draft?.id === id && draft.body) {
      this.show({ id, text: draft.body });
      this.synced = '';
      this.untouched = false;
      const note = this.notes.find(id);
      if (note) this.merge(id, note.body);
      return;
    }
    // `known`: the text of a note just made here, which may not be in
    // the list yet; typing must never start on an empty stand-in.
    this.show({ id, text: this.notes.find(id)?.body ?? known ?? '' });
  }

  /**
   * Puts an earlier version back (History). Unsaved typing is saved
   * first, so history keeps it too; the note opens with the old text.
   */
  restore(id: string, body: string): void {
    if (!this.notes.ready) return;
    const open = id === this.open().id;
    if (open) this.flush();
    else this.closeCurrent();
    // What the note says until the restore lands: the typing just saved,
    // or the note as this device has it.
    const replaced = open ? this.body : this.notes.find(id)?.body;
    this.store.remove(PENDING_DRAFT_KEY);
    this.notes.save(id, body, { restore: true });
    this.show({ id, text: body });
    // The restored text is the note now: a snapshot still carrying the
    // text it replaced must not merge back over it.
    this.replaced = replaced === undefined ? undefined : { id, text: replaced };
    this.untouched = false;
  }

  /** Starts a fresh, empty note, which becomes the capture note. */
  newNote(): void {
    this.closeCurrent();
    this.show({ id: this.notes.newId(), text: '' });
    this.home.set(this.open().id);
  }

  /** Back to the capture note (`/`), from another note. */
  openHome(): void {
    this.openNote(this.home());
  }

  /** The app is being hidden: save, tidy, and stamp the time. */
  leave(): void {
    this.flush();
    this.store.set(LAST_SEEN_KEY, { hiddenAt: this.now(), noteId: this.open().id });
  }

  /** The app is visible again: after 5 minutes away, a fresh note. */
  returned(): void {
    const seen = this.store.get<LastSeen>(LAST_SEEN_KEY);
    if (shouldStartFreshNote(seen?.hiddenAt, this.now())) {
      this.newNote();
      this.renewed.update((n) => n + 1);
    }
  }

  private closeCurrent(): void {
    this.flush();
    const { id } = this.open();
    // Only a note emptied by typing here is deleted: an untouched one may
    // simply not have loaded yet, and must never be removed.
    if (!this.untouched && !this.body.trim() && !this.isKept(id)) {
      if (this.notes.exists(id)) this.notes.remove(id);
      return;
    }
    // Leaving a note settles it (Eric, 2026-10-06): New, another note,
    // a restore elsewhere, or a fresh note after five minutes away.
    // Before the notes load, hold it on the device like the launch case.
    if (this.notes.ready) {
      this.notes.settle(id, { edited: !this.untouched });
      // New names linked here become concepts (#29).
      if (!this.untouched) this.notes.plantConcepts(this.body);
    } else if (this.notes.exists(id) || !this.untouched) this.store.set(PENDING_SETTLE_KEY, id);
  }

  private show(note: OpenNote): void {
    this.open.set(note);
    this.body = note.text;
    this.synced = note.text;
    this.dirty = false;
    this.untouched = true;
  }
}
