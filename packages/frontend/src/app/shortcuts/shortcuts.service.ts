import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, Injector, afterNextRender, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';
import { NewNoteService } from '../home/new-note';
import { PLACES, type PlaceId, placeOn } from '../home/places';
import { ModulesService } from '../modules/modules.service';
import { offRail } from '../rail/rail';
import { SETTINGS_PAGES } from '../settings/settings-pages';
import {
  type Command,
  GO_KEYS,
  GO_WAIT_MS,
  MODIFIER_KEYS,
  OWNS_KEYS,
  PLACE_ORDER,
  composing,
  editable,
  isBoxChord,
  placeForKey,
} from './shortcuts';

/** Taken: nothing else hears it, the browser included. */
function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * The one owner of the app-wide keys (#289; DESIGN.md, The desktop
 * shell's keys): a single keydown listener on the document, so the
 * guards are kept in one place. It is made by the app shell before any
 * screen, so its listener comes before the screens' own document
 * listeners (the Reader's j, k, m, s, v), and `g`'s letter, taken with
 * stopImmediatePropagation, never reaches them. Element handlers (the
 * editor's keymap, a field's Enter) run before it, and what they took
 * (`defaultPrevented`) it leaves alone.
 *
 * Nothing here is stored and nothing waits on the network: the keys
 * only navigate, focus and open the box.
 */
@Injectable({ providedIn: 'root' })
export class ShortcutsService {
  private readonly doc = inject(DOCUMENT);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  /** `g` was pressed and its letter is awaited until this fires. */
  private timer?: ReturnType<typeof setTimeout>;
  /** Screens' own searches (the Reader's), the latest drawn first. */
  private searches: (() => void)[] = [];
  private opener?: () => void;

  constructor() {
    const listener = (event: KeyboardEvent) => this.keydown(event);
    this.doc.addEventListener('keydown', listener);
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('keydown', listener);
      this.cancel();
    });
  }

  /** Whether `g` is waiting for its letter. */
  get waiting(): boolean {
    return this.timer !== undefined;
  }

  /** The command box shows itself through this (CommandBox, in the shell). */
  attachBox(open: () => void): () => void {
    this.opener = open;
    return () => {
      if (this.opener === open) this.opener = undefined;
    };
  }

  /**
   * A screen with a search of its own (the Reader's Search articles)
   * takes `/` while it is drawn; undone when it goes.
   */
  ownSearch(open: () => void): () => void {
    this.searches.push(open);
    return () => {
      this.searches = this.searches.filter((s) => s !== open);
    };
  }

  private keydown(event: KeyboardEvent): void {
    if (composing(event)) return;
    if (event.defaultPrevented || !this.active()) return this.cancel();
    if (isBoxChord(event)) {
      // The one key heard in a field too; not over another dialog.
      this.cancel();
      if (this.doc.querySelector(OWNS_KEYS)) return;
      consume(event);
      this.opener?.();
      return;
    }
    if (editable(event.target) || this.doc.querySelector(OWNS_KEYS)) return this.cancel();
    if (this.waiting) {
      if (MODIFIER_KEYS.has(event.key)) return;
      this.cancel();
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // Tab, the arrows and the like go on as ever; a character or
      // Escape is the sequence's, whether or not it names a place.
      if (event.key !== 'Escape' && event.key.length !== 1) return;
      consume(event);
      const place = placeForKey(event.key);
      if (place) this.go(place);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'g' && !event.shiftKey) {
      // Not stopped: a screen's own listener may hear it, though none
      // uses it.
      event.preventDefault();
      this.timer = setTimeout(() => (this.timer = undefined), GO_WAIT_MS);
      return;
    }
    if (event.key === '/') {
      // Browse's own `/` (#288) still hears it, and does the same.
      event.preventDefault();
      this.search();
    }
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Signed in (or restoring), and on a screen of the garden: not the
   * development sign-in or Claude's consent page, as the rail.
   */
  private active(): boolean {
    return this.injector.get(AuthService).user() !== null && !offRail(this.router.url);
  }

  /** To a place, if its module is on. */
  go(id: PlaceId): void {
    if (!placeOn(id, this.injector.get(ModulesService))) return;
    void this.router.navigateByUrl(PLACES[id].link);
  }

  /** `/`: the screen's own search where it has one, else Notes'. */
  search(): void {
    const own = this.searches.at(-1);
    if (own) own();
    else this.searchNotes();
  }

  /** Notes' search box (Browse's Search notes), going to `/browse` first if need be. */
  searchNotes(): void {
    const box = () => this.doc.querySelector<HTMLInputElement>('app-browse input[type="search"]');
    const here = box();
    if (here) {
      here.focus();
      return;
    }
    void this.router.navigateByUrl('/browse').then((went) => {
      if (went) afterNextRender(() => box()?.focus(), { injector: this.injector });
    });
  }

  /**
   * What the box offers: every place that shows, New note, Search
   * notes, and each page of Settings by name.
   */
  commands(): Command[] {
    const modules = this.injector.get(ModulesService);
    return [
      ...PLACE_ORDER.filter((id) => placeOn(id, modules)).map((id) => ({
        id: `go-${id}`,
        label: `Go to ${PLACES[id].name}`,
        keys: `g ${GO_KEYS[id]}`,
        run: () => this.go(id),
      })),
      {
        id: 'new-note',
        label: 'New note',
        run: () => void this.injector.get(NewNoteService).start(),
      },
      { id: 'search-notes', label: 'Search notes', keys: '/', run: () => this.searchNotes() },
      ...SETTINGS_PAGES.map((page) => ({
        id: `settings-${page.id}`,
        label: `Settings: ${page.name}`,
        run: () => void this.router.navigateByUrl(`/settings/${page.id}`),
      })),
    ];
  }
}
