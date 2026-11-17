import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { merge3, shouldStartFreshNote, templateParts } from '@mossgoblin/schema';
import { type NoteRecord, NotesService } from '../notes/notes.service';
import { LocalStore } from '../platform/local-store';
import { NOW } from '../platform/platform';
import { LAST_PLACE_KEY, noteOf, readPlace } from '../launch/place';

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
  /**
   * Typed for a note this device could not open (step 3a): a fragment
   * to merge into its text when it opens, never the whole of it. Kept
   * on the draft itself, so a reload before the note opens still knows
   * (review on #262).
   */
  forLocked?: true;
}

export const LAST_SEEN_KEY = 'goblin.lastSeen';
export const PENDING_DRAFT_KEY = 'goblin.pendingDraft';
export const PENDING_SETTLE_KEY = 'goblin.pendingSettle';
export const SAVE_DELAY_MS = 300;
/** How many of its own saved texts the open note remembers. */
const SENT_KEPT = 50;

/**
 * The capture loop (DESIGN.md, Client): which note is open, saving it as
 * it is typed, and the rules for launch.
 *
 * - At launch, `/` shows the capture note it showed when the app was
 *   last left there, however long ago (#272, 2026-11-15); left anywhere
 *   else, a fresh one, and the app goes back there (LastPlaceService).
 *   With no place kept yet: within 5 minutes the note that was open,
 *   else a fresh one, as before. Coming back to the app changes nothing.
 * - Typing is saved 300 ms after it pauses, and at once when the app is
 *   hidden. Until the user is known and their notes have loaded, it is
 *   kept as a pending draft on the device and written after, so nothing
 *   is lost and an unseen note is never overwritten. After, each save
 *   is kept on the device until the server acknowledges it (#200).
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
   * The capture note, the one `/` shows: chosen at launch (the one `/`
   * showed when the app was left there, else a fresh one), and replaced
   * by New. Other notes have their own URL, `/n/<id>`.
   */
  readonly home = signal('');

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
  /**
   * Texts this device saved for the open note, oldest first. A snapshot
   * of one, written by this device, is a late echo of its own write, not
   * news: merging it would undo everything typed since (2026-10-07, a
   * note on Eric's phone came back with two lines both before and after
   * his edit). The same text from another writer is a real change.
   */
  private sent: string[] = [];
  /** The text a restore just replaced, until a newer snapshot arrives. */
  private replaced?: { id: string; text: string };
  private dirty = false;
  /** The pending draft waited for its note to open (step 3a). */
  private draftWaited = false;
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
      const place = readPlace(this.store.get<unknown>(LAST_PLACE_KEY));
      let resume: string | undefined;
      if (place) {
        // Where he left off (#272, 2026-11-15), however long ago: `/`
        // shows the capture note it showed then; with any other place
        // to go back to, a fresh one. The note left open is settled, as
        // leaving it does, unless it is the one he is going back to.
        resume = place.url === '/' ? place.note : undefined;
        const back = resume ?? noteOf(place.url);
        if (seen?.noteId && seen.noteId !== back) this.store.set(PENDING_SETTLE_KEY, seen.noteId);
      } else {
        // No place kept yet (a device on its first launch of this
        // version): the rule before, the note open within five minutes.
        const fresh = shouldStartFreshNote(seen?.hiddenAt, this.now()) || !seen?.noteId;
        // A fresh note after five minutes away settles the one left then.
        if (fresh && seen?.noteId) this.store.set(PENDING_SETTLE_KEY, seen.noteId);
        resume = fresh ? undefined : seen?.noteId;
      }
      this.show({ id: resume ?? this.notes.newId(), text: '' });
    }
    this.home.set(this.open().id);

    // The open note changed elsewhere (another device, Claude), or a
    // resumed note's text arrived: merge it with anything typed since
    // the last sync, so neither side's text is lost (#37). A locked
    // note's placeholder is not its text (step 3a): nothing is merged
    // from it, and once it opens its text merges in then.
    // Words held on this device for the key (2026-11-15) are the open
    // note's text here, a new note's or an existing one's (review on
    // #276): after a reload they are shown, merged over the note's text
    // now, never the server's alone, which typing would then replace
    // them with (`showHeld`).
    effect(() => {
      const list = this.notes.notes();
      this.notes.waitingForKey();
      untracked(() => {
        const { id } = this.open();
        const note = list.find((n) => n.id === id);
        this.showHeld(id, note);
        if (note && !note.locked) this.merge(id, note.body, note.deviceId);
      });
    });

    // Once the user is known, write any pending settle and draft. A
    // draft for a note this device cannot open yet stays on the device
    // until it opens (step 3a), and then merges into its text, as
    // typing before it arrived does.
    effect(() => {
      // Loaded. Without the key `save` holds the draft on the device
      // (2026-11-15), so nothing waits on it here.
      if (!this.notes.loaded()) return;
      const list = this.notes.notes();
      untracked(() => {
        // The draft first, so the settle's title sees the final text.
        const pending = this.store.get<PendingDraft>(PENDING_DRAFT_KEY);
        if (pending && this.notes.locked(pending.id)) {
          this.draftWaited = true;
          // Whatever it was typed as, it waited for a locked note.
          if (!pending.forLocked) {
            this.store.set(PENDING_DRAFT_KEY, { ...pending, forLocked: true });
          }
        } else if (pending && this.notes.heldSave(pending.id)) {
          // A draft typed before the notes loaded, for a note whose words
          // are held on this device (review on #276): never saved over
          // them. The open note's merges with them in the editor; another
          // note's merges into them here, over the server's text.
          if (pending.id === this.open().id) {
            this.showHeld(
              pending.id,
              list.find((n) => n.id === pending.id),
            );
            // The draft's words are in the editor now: saved, held, from there.
            if (this.body !== this.notes.heldSave(pending.id)?.value) {
              this.dirty = true;
              clearTimeout(this.timer);
              this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
            }
          } else if (pending.body.trim()) {
            const held = this.notes.heldSave(pending.id)!;
            const note = list.find((n) => n.id === pending.id);
            const base = held.base ?? '';
            const into =
              note === undefined || note.body === base
                ? held.value
                : merge3(base, held.value, note.body);
            this.notes.save(pending.id, merge3('', pending.body, into), {
              ...(note ? { base: note.body } : held.base === undefined ? {} : { base: held.base }),
            });
          }
          this.store.remove(PENDING_DRAFT_KEY);
          this.draftWaited = false;
        } else if (pending) {
          const waited = this.draftWaited || pending.forLocked === true;
          const note = waited ? list.find((n) => n.id === pending.id) : undefined;
          // The open note, new here: its editor holds the draft and
          // whatever came since (a shared photo inside the typing
          // pause), so that is what is written, as the editor's own
          // save. The older draft written alone came back as news and
          // merged in as a second copy of its words (2026-11-17). An
          // editor holding nothing never stands in for a draft that
          // holds words: then the draft is written, as before.
          const fresh = !list.some((n) => n.id === pending.id);
          if (!waited && fresh && pending.id === this.open().id && this.body.trim()) {
            const text = this.body;
            clearTimeout(this.timer);
            this.dirty = false;
            this.notes.save(pending.id, text);
            this.synced = text;
            this.sent = [...this.sent, text].slice(-SENT_KEPT);
          } else if (note && pending.body.trim()) {
            const text = merge3('', pending.body, note.body);
            if (text !== note.body) this.notes.save(pending.id, text, { base: note.body });
          } else if (pending.body.trim()) this.notes.save(pending.id, pending.body);
          this.store.remove(PENDING_DRAFT_KEY);
          this.draftWaited = false;
        }
        const settle = this.store.get<string>(PENDING_SETTLE_KEY);
        if (settle) {
          this.notes.settle(settle, { edited: settle === pending?.id && !!pending.body.trim() });
          this.store.remove(PENDING_SETTLE_KEY);
        }
      });
    });

    const doc = inject(DOCUMENT);
    // Coming back to the app, however long after, changes nothing: the
    // note open stays open (#272, 2026-11-15; until then five minutes
    // away opened a fresh one).
    const onVisibility = () => {
      if (doc.hidden) this.leave();
    };
    const onPageHide = () => this.leave();
    doc.addEventListener('visibilitychange', onVisibility);
    doc.defaultView?.addEventListener('pagehide', onPageHide);
    inject(DestroyRef).onDestroy(() => {
      doc.removeEventListener('visibilitychange', onVisibility);
      doc.defaultView?.removeEventListener('pagehide', onPageHide);
      clearTimeout(this.timer);
    });
  }

  private merge(id: string, remote: string, writer?: string): void {
    if (remote === this.synced) return;
    if (writer?.startsWith(this.notes.deviceId()) && this.sent.includes(remote)) return;
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
    // Typed before the note turned out to be one this device cannot
    // open (step 3a): kept on the device as a draft, never written over
    // it, and merged in once it opens.
    if (this.notes.locked(id)) {
      if (this.body.trim()) {
        this.store.set(PENDING_DRAFT_KEY, { id, body: this.body, forLocked: true });
      }
      return;
    }
    // Words held on this device for this note not shown yet (review on
    // #276): merged in first, so this save is built on them.
    if (this.heldShown !== id && this.notes.heldSave(id)) {
      this.showHeld(id, this.notes.find(id));
      clearTimeout(this.timer);
      this.dirty = false;
    }
    // This text is newer than any pending draft, which must not land
    // on top of it later.
    this.dropDraft();
    const base = this.synced;
    this.synced = this.body;
    this.sent = [...this.sent, this.body].slice(-SENT_KEPT);
    // A save held on the device (2026-11-15) never reached the server:
    // what it has is still the base, so a change from elsewhere merges
    // against that, not against words only this device has (below).
    const heldBefore = this.notes.heldForKey(id);
    // A concept is never deleted for having no text: its name, type and
    // other names are what it is (review on #66). Nor is a template.
    if (this.body.trim() || this.isKept(id)) {
      this.notes.save(id, this.body, keep ? { base, keep } : { base });
      if (heldBefore || this.notes.heldForKey(id)) {
        this.synced = base;
        // Held from this editor's own text: it is what shows already.
        this.heldShown = id;
      }
    } else if (this.notes.exists(id)) this.notes.remove(id);
  }

  /** The note whose held words were shown, once each time it is opened. */
  private heldShown?: string;

  /**
   * Shows the words held on this device for note `id` (`heldSave`),
   * once per opening, while nothing has been typed over them: merged
   * over the note's text now when that moved on from the base they were
   * typed over (another device, Claude), else as they are. The base the
   * editor merges later changes against stays the server's text, so
   * typing extends the held words and is saved over that.
   */
  private showHeld(id: string, note?: NoteRecord): void {
    if (this.heldShown === id || note?.locked) return;
    const held = this.notes.heldSave(id);
    if (!held) return;
    this.heldShown = id;
    const server = note?.body;
    const base = held.base ?? '';
    const shown =
      server === undefined || server === base ? held.value : merge3(base, held.value, server);
    // Typed before the held words were shown (review on #276: before the
    // notes list arrived): merged with them, typed against what the
    // editor showed, so neither the held words nor the new keystrokes
    // are dropped (merge3 keeps both sides).
    const local = this.body;
    const text = local === this.synced ? shown : merge3(this.synced, local, shown);
    this.synced = server ?? base;
    this.body = text;
    this.open.set({ id, text, base: local });
    this.untouched = false;
    // Merged over newer text or with typing: saved again over the
    // server's text, still held.
    if (text !== held.value) {
      this.dirty = true;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    }
  }

  /**
   * Kinds that stay when emptied: concepts, templates, the context note,
   * and recipes and meal plans, which have a name and fields of their own.
   */
  private isKept(id: string): boolean {
    const kind = this.notes.find(id)?.kind;
    return ['concept', 'template', 'context', 'recipe', 'mealplan', 'pantry'].includes(kind ?? '');
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
      if (note) this.merge(id, note.body, note.deviceId);
      return;
    }
    // `known`: the text of a note just made here, which may not be in
    // the list yet; typing must never start on an empty stand-in. Nor on
    // the server's text of a note whose words are held here (2026-11-15).
    const note = this.notes.find(id);
    this.show({ id, text: note?.body ?? known ?? '' });
    this.showHeld(id, note);
  }

  /**
   * Puts an earlier version back (History). Unsaved typing is saved
   * first, so history keeps it too; the note opens with the old text.
   */
  restore(id: string, body: string): void {
    if (!this.notes.ready || this.notes.locked(id)) return;
    const open = id === this.open().id;
    if (open) this.flush();
    else this.closeCurrent();
    // What the note says until the restore lands: the typing just saved,
    // or the note as this device has it.
    const replaced = open ? this.body : this.notes.find(id)?.body;
    this.dropDraft();
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

  private closeCurrent(): void {
    this.flush();
    const { id } = this.open();
    // A locked note is left as it is: never removed, settled or bare.
    if (this.notes.locked(id)) return;
    // Only a note emptied by typing here is deleted: an untouched one may
    // simply not have loaded yet, and must never be removed.
    if (!this.untouched && !this.body.trim() && !this.isKept(id)) {
      if (this.notes.exists(id)) this.notes.remove(id);
      return;
    }
    // An entry left as its template's skeleton held nothing of Eric's: a
    // reminder tapped and dismissed must not leave one behind (#40).
    if (this.isBareEntry(id)) {
      this.notes.remove(id);
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

  /**
   * Forgets the pending draft, which newer text replaces, unless it is
   * another note's, waiting for that note to open (step 3a).
   */
  private dropDraft(): void {
    const draft = this.store.get<PendingDraft>(PENDING_DRAFT_KEY);
    if (draft && draft.id !== this.open().id && this.notes.locked(draft.id)) return;
    this.store.remove(PENDING_DRAFT_KEY);
  }

  /** A note made from an entry template whose text is still the skeleton. */
  private isBareEntry(id: string): boolean {
    const from = this.notes.find(id)?.fromTemplate;
    const template = from === undefined ? undefined : this.notes.find(from);
    if (template?.kind !== 'template' || template.templateMode === 'living') return false;
    return this.body.trim() === templateParts(template.body, template.instructions).skeleton.trim();
  }

  private show(note: OpenNote): void {
    this.heldShown = undefined;
    this.open.set(note);
    this.body = note.text;
    this.synced = note.text;
    this.sent = [];
    this.dirty = false;
    this.untouched = true;
  }
}
