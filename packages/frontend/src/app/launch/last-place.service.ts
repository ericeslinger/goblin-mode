import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  type EffectRef,
  Injectable,
  Injector,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { CONTEXT_ID } from '@mossgoblin/schema';
import { SIGNED_IN_KEY } from '../auth.service';
import { CaptureService } from '../capture/capture.service';
import type { StartModules } from '../home/start-on';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { LocalStore } from '../platform/local-store';
import { SESSION_STORAGE } from '../platform/platform';
import { VISITED_KEY } from '../reader/visited-key';
import {
  LAST_PLACE_KEY,
  type LastPlace,
  type PlaceModule,
  type Spot,
  keptUrl,
  moduleOf,
  noteOf,
  readPlace,
} from './place';

/**
 * How often a restore looks for its content, and for how long (15 s):
 * a page loaded again can wait on the server's first answer for its
 * notes. The checks for a place gone last as long.
 */
export const RESTORE_EVERY_MS = 50;
export const RESTORE_TRIES = 300;
/** A scroll is remembered once it rests this long. */
export const SAVE_AFTER_MS = 250;

/**
 * What a screen scrolls in, when not the window: the note editor's own
 * scroller, with its caret. `apply` is false while what was scrolled is
 * not there yet.
 */
export interface PlaceSource {
  read(): Spot;
  apply(spot: Spot): boolean;
}

/** Input that means the gardener is moving on his own: a restore stops. */
const INTENT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * Where he left off (#272, Eric, 2026-11-15). Every screen shown is
 * remembered on this device, with how far it was scrolled, as it rests
 * and when the app is hidden; a plain launch of `/` (Start on's Where I
 * left off) goes back to it, its scroll put back once its content is
 * there, unless he scrolls, taps or types first. A place that has gone
 * (a note deleted, in Trash or sealed here; a module turned off) falls
 * back to Home. Made at boot, so it sees the first navigation.
 */
@Injectable({ providedIn: 'root' })
export class LastPlaceService {
  private readonly store = inject(LocalStore);
  private readonly session = inject(SESSION_STORAGE);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly doc = inject(DOCUMENT);

  /** The place as the last visit left it, read once, before anything is written. */
  private readonly found = readPlace(this.store.get<unknown>(LAST_PLACE_KEY));
  /** The screen shown now, as remembered; undefined for one not to come back to. */
  private url?: string;
  private source?: PlaceSource;
  /** The place a launch is going back to, until its navigation ends. */
  private arriving?: LastPlace;
  private arrivedOnce = false;
  /** The place being checked for having gone, until he moves or the time is up. */
  private readonly restoring = signal<LastPlace | undefined>(undefined);
  private checks?: EffectRef;
  private checksTimer?: ReturnType<typeof setTimeout>;
  /** A scroll waiting for its content; nothing is remembered meanwhile. */
  private scrolling = false;
  private tries = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.router.events.pipe(takeUntilDestroyed()).subscribe((e) => {
      if (e instanceof NavigationEnd) this.arrived(e.urlAfterRedirects);
    });
    const doc = this.doc;
    const onScroll = () => this.saveSoon();
    const onVisibility = () => {
      if (doc.hidden) this.save();
    };
    const onPageHide = () => this.save();
    const onIntent = () => {
      this.stopScroll();
      // His own move: from here the screen shows what it shows.
      this.endChecks();
    };
    doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
    doc.addEventListener('visibilitychange', onVisibility);
    doc.defaultView?.addEventListener('pagehide', onPageHide);
    for (const type of INTENT)
      doc.addEventListener(type, onIntent, { capture: true, passive: true });
    inject(DestroyRef).onDestroy(() => {
      doc.removeEventListener('scroll', onScroll, { capture: true });
      doc.removeEventListener('visibilitychange', onVisibility);
      doc.defaultView?.removeEventListener('pagehide', onPageHide);
      for (const type of INTENT) doc.removeEventListener(type, onIntent, { capture: true });
      clearTimeout(this.timer);
      clearTimeout(this.saveTimer);
      this.endChecks();
    });
  }

  /**
   * Where a plain launch of `/` goes: the last place, or `/` itself on
   * a first launch, on a device never signed in, or when `/` was the
   * place (the capture note it showed, which CaptureService resumes);
   * Home for a module turned off since, as far as this device knows.
   */
  launch(on: StartModules): string {
    const place = this.found;
    if (!place || !this.signedIn()) return '/';
    const module = moduleOf(place.url);
    if (module && !on[module]) return '/home';
    this.carryVisits(place);
    this.arriving = place;
    this.watch(place);
    return place.url;
  }

  /** A screen that scrolls in an element of its own; undone when it goes. */
  register(source: PlaceSource): () => void {
    this.source = source;
    return () => {
      if (this.source === source) this.source = undefined;
    };
  }

  /** Remembers the screen shown now, at once. */
  save(): void {
    clearTimeout(this.saveTimer);
    if (!this.url || this.scrolling) return;
    const place: LastPlace = { url: this.url, ...this.read() };
    if (this.url.startsWith('/reader/a/')) {
      const visited = this.sessionGet(VISITED_KEY);
      if (visited) place.visited = visited;
    }
    this.store.set(LAST_PLACE_KEY, place);
  }

  private saveSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_AFTER_MS);
  }

  private read(): Spot {
    if (this.source) return this.source.read();
    const top = Math.round(this.doc.scrollingElement?.scrollTop ?? 0);
    return top > 0 ? { top } : {};
  }

  private arrived(url: string): void {
    const place = this.arriving;
    this.arriving = undefined;
    const first = !this.arrivedOnce;
    this.arrivedOnce = true;
    const restoring = untracked(this.restoring);
    if (restoring && restoring.url !== url) this.endChecks();
    this.stopScroll();
    this.url = this.kept(url);
    if (place?.url === url) this.startScroll(place);
    // Opened cold at the place's own address (a reload, or a phone that
    // reopens the app where it was): the scroll is put back as well.
    else if (first && this.found?.url === url && this.signedIn()) this.startScroll(this.found);
    else this.save();
  }

  private signedIn(): boolean {
    return this.store.get<boolean>(SIGNED_IN_KEY) === true;
  }

  /** The URL to remember, but never an address this version does not know. */
  private kept(url: string): string | undefined {
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    return route.routeConfig?.path === '**' ? undefined : keptUrl(url);
  }

  private startScroll(place: LastPlace): void {
    if (!place.top && place.caret === undefined) return;
    this.scrolling = true;
    this.tries = 0;
    this.step(place);
  }

  private step(place: LastPlace): void {
    if (!this.scrolling) return;
    if (this.apply(place) || ++this.tries >= RESTORE_TRIES) {
      this.scrolling = false;
      return;
    }
    this.timer = setTimeout(() => this.step(place), RESTORE_EVERY_MS);
  }

  /** The window's scroll, once the page is long enough to hold it. */
  private apply(spot: Spot): boolean {
    if (this.source) return this.source.apply(spot);
    const el = this.doc.scrollingElement;
    const top = spot.top ?? 0;
    if (!el || top <= 0) return true;
    if (el.scrollHeight - el.clientHeight < top) return false;
    el.scrollTop = top;
    return true;
  }

  /** He scrolled, tapped or typed first, or went elsewhere: his move wins. */
  private stopScroll(): void {
    if (!this.scrolling) return;
    this.scrolling = false;
    clearTimeout(this.timer);
  }

  /**
   * Checks, once what it needs is known, that the place is still there:
   * its module on, its note neither gone, in Trash nor sealed here. The
   * notes come from the persisted cache first, which can be behind (a
   * note deleted on the laptop), so it keeps checking as the server's
   * answer lands, until he moves or the restore's time is up.
   */
  private watch(place: LastPlace): void {
    const module = moduleOf(place.url);
    const note = noteOf(place.url) ?? (place.url === '/' ? place.note : undefined);
    if (!module && !note) return;
    this.restoring.set(place);
    this.checks = effect(
      () => {
        if (this.restoring() !== place) return;
        if (this.verdict(place, module, note) !== false) return;
        untracked(() => {
          this.endChecks();
          this.fallBack(place);
        });
      },
      { injector: this.injector },
    );
    this.checksTimer = setTimeout(() => this.endChecks(), RESTORE_EVERY_MS * RESTORE_TRIES);
  }

  private endChecks(): void {
    clearTimeout(this.checksTimer);
    this.checks?.destroy();
    this.checks = undefined;
    if (untracked(this.restoring)) this.restoring.set(undefined);
  }

  /** False once the place has gone; true while it stands; undefined until known. */
  private verdict(
    place: LastPlace,
    module: PlaceModule | undefined,
    note: string | undefined,
  ): boolean | undefined {
    if (module) {
      const modules = this.injector.get(ModulesService);
      if (!modules.loaded()) return undefined;
      if (!modules[module]()) return false;
    }
    if (!note || note === CONTEXT_ID) return true;
    const notes = this.injector.get(NotesService);
    if (!notes.loaded()) return undefined;
    if (place.url === '/') {
      // The capture note: only the one this launch resumed, and never
      // over words typed in it (or a draft shown in its place).
      const capture = this.injector.get(CaptureService);
      if (capture.open().id !== note) return true;
      if (notes.trashed(note) !== undefined || notes.locked(note)) return false;
      return notes.exists(note) || !place.saved || !!capture.current().trim();
    }
    if (notes.trashed(note) !== undefined || notes.locked(note)) return false;
    return notes.exists(note);
  }

  /** Home, calmly, unless he has moved on already. */
  private fallBack(place: LastPlace): void {
    this.stopScroll();
    if (this.kept(this.router.url) !== place.url) return;
    // Never a blank note standing in for the one that went.
    if (place.url === '/') this.injector.get(CaptureService).newNote();
    void this.router.navigateByUrl('/home', { replaceUrl: true });
  }

  /**
   * An app closed and opened again has a new tab, and the Reader's run
   * through the shelf (#188) was in the old one's sessionStorage: it is
   * put back for the article, unless this tab has a run of its own.
   */
  private carryVisits(place: LastPlace): void {
    if (!place.visited || !place.url.startsWith('/reader/a/')) return;
    if (this.sessionGet(VISITED_KEY) !== null) return;
    try {
      this.session?.setItem(VISITED_KEY, place.visited);
    } catch {
      // Refused: the run starts afresh, as after any new tab.
    }
  }

  private sessionGet(key: string): string | null {
    try {
      return this.session?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
}
