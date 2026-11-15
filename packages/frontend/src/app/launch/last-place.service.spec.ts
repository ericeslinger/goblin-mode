import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { SIGNED_IN_KEY } from '../auth.service';
import { CaptureService, PENDING_DRAFT_KEY } from '../capture/capture.service';
import { START_ON_KEY, startOnGuard } from '../home/start-on';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { VISITED_KEY } from '../reader/visited-key';
import { FakeModules, FakeNotes, noteRecord } from '../testing/fakes';
import {
  LastPlaceService,
  type PlaceSource,
  RESTORE_EVERY_MS,
  RESTORE_TRIES,
  SAVE_AFTER_MS,
} from './last-place.service';
import { LAST_PLACE_KEY, type Spot, keptUrl, moduleOf, noteOf, readPlace } from './place';

@Component({ template: 'here' })
class Here {}

const routes = [
  { path: '', component: Here, canActivate: [startOnGuard] },
  { path: 'n/:id', component: Here },
  { path: 'home', component: Here },
  { path: 'settings', component: Here },
  { path: 'kitchen', component: Here },
  { path: 'reader', component: Here },
  { path: 'reader/a/:id', component: Here },
  { path: 'share', component: Here },
  { path: 'dev-sign-in', component: Here },
  { path: '**', component: Here },
];

interface Options {
  stored?: Record<string, unknown>;
  signedIn?: boolean;
  notes?: FakeNotes;
  modules?: FakeModules;
}

/** Opens the app cold at `url`, with what this device has stored. */
async function coldOpen(url: string, options: Options = {}) {
  localStorage.clear();
  sessionStorage.clear();
  if (options.signedIn ?? true) localStorage.setItem(SIGNED_IN_KEY, 'true');
  for (const [k, v] of Object.entries(options.stored ?? {})) {
    localStorage.setItem(k, JSON.stringify(v));
  }
  const notes = options.notes ?? new FakeNotes();
  const modules = options.modules ?? new FakeModules();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      { provide: NotesService, useValue: notes },
      { provide: ModulesService, useValue: modules },
    ],
  });
  // At boot, as app.config makes them.
  const capture = TestBed.inject(CaptureService);
  const place = TestBed.inject(LastPlaceService);
  const harness = await RouterTestingHarness.create(url);
  const router = TestBed.inject(Router);
  const stored = () => JSON.parse(localStorage.getItem(LAST_PLACE_KEY) ?? 'null');
  const settle = async () => {
    TestBed.tick();
    await harness.fixture.whenStable();
  };
  return { router, place, capture, notes, modules, stored, settle };
}

/** A screen scrolling in an element of its own, its content there once `ready`. */
function fakeSource(initial: Spot = {}) {
  const state = { spot: initial, ready: false, applied: [] as Spot[] };
  const source: PlaceSource = {
    read: () => state.spot,
    apply: (spot) => {
      if (!state.ready) return false;
      state.applied.push(spot);
      state.spot = spot;
      return true;
    },
  };
  return { state, source };
}

describe('the last place (#272)', () => {
  it('keeps no place while signed out (review on #281)', async () => {
    const { router, place, stored, settle } = await coldOpen('/settings', { signedIn: false });
    await settle();
    await router.navigateByUrl('/home');
    await settle();
    place.save();
    expect(stored()).toBeNull();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('what is remembered', () => {
    it('keeps the URL to go back to, never a share, sign-in or an address being tidied', () => {
      expect(keptUrl('/')).toBe('/');
      expect(keptUrl('/reader/a/x1?in=f%3Adesign')).toBe('/reader/a/x1?in=f%3Adesign');
      expect(keptUrl('/settings')).toBe('/settings');
      // A reminder's entry is not made again on the way back.
      expect(keptUrl('/n/n1?from=reminder')).toBe('/n/n1');
      expect(keptUrl('/share?text=hi&at=1')).toBeUndefined();
      expect(keptUrl('/dev-sign-in')).toBeUndefined();
      expect(keptUrl('/oauth/authorize?client_id=c')).toBeUndefined();
      expect(keptUrl('/?text=hello')).toBeUndefined();
      expect(keptUrl('/?shared=2')).toBeUndefined();
    });

    it('knows a place’s note and module', () => {
      expect(noteOf('/n/c-kiln')).toBe('c-kiln');
      expect(noteOf('/n/a%20b')).toBe('a b');
      expect(noteOf('/reader')).toBeUndefined();
      expect(moduleOf('/kitchen/recipes')).toBe('kitchen');
      expect(moduleOf('/reader/a/x1?in=all')).toBe('reader');
      expect(moduleOf('/podcasts/e/x2')).toBe('podcasts');
      expect(moduleOf('/reader/downloads')).toBeUndefined();
      expect(moduleOf('/settings')).toBeUndefined();
    });

    it('reads back only a place it can go to', () => {
      expect(readPlace({ url: '/n/n1', top: 300, caret: 12 })).toEqual({
        url: '/n/n1',
        top: 300,
        caret: 12,
      });
      expect(readPlace({ url: '/share?text=x' })).toBeUndefined();
      expect(readPlace({ url: 'https://elsewhere.invalid/' })).toBeUndefined();
      expect(readPlace({ url: '//elsewhere.invalid/' })).toBeUndefined();
      expect(readPlace('junk')).toBeUndefined();
      expect(readPlace({ url: '/', top: -4, note: 'n1', saved: 'yes' })).toEqual({
        url: '/',
        note: 'n1',
      });
    });

    it('remembers each screen shown, and its scroll as it rests and as the app is hidden', async () => {
      const { router, place, stored, settle } = await coldOpen('/settings');
      expect(stored()).toEqual({ url: '/settings' });
      await router.navigateByUrl('/n/n1');
      await settle();
      const { state, source } = fakeSource({ top: 640, caret: 88 });
      const off = place.register(source);
      vi.useFakeTimers();
      document.dispatchEvent(new Event('scroll'));
      expect(stored()).toEqual({ url: '/n/n1' });
      vi.advanceTimersByTime(SAVE_AFTER_MS);
      expect(stored()).toEqual({ url: '/n/n1', top: 640, caret: 88 });
      state.spot = { top: 700, caret: 90 };
      window.dispatchEvent(new Event('pagehide'));
      expect(stored()).toEqual({ url: '/n/n1', top: 700, caret: 90 });
      off();
    });

    it('does not remember a share, sign-in or an address this version does not know', async () => {
      const { router, stored, settle } = await coldOpen('/settings');
      for (const url of ['/share?text=x&at=1', '/dev-sign-in', '/no-such-screen']) {
        await router.navigateByUrl(url);
        await settle();
        window.dispatchEvent(new Event('pagehide'));
        expect(stored()).toEqual({ url: '/settings' });
      }
    });

    it('keeps an article’s run through its shelf with it (#188)', async () => {
      const { router, stored, settle } = await coldOpen('/reader');
      sessionStorage.setItem(VISITED_KEY, JSON.stringify({ shelf: 'all', ids: ['x0', 'x1'] }));
      await router.navigateByUrl('/reader/a/x1?in=all');
      await settle();
      expect(stored()).toMatchObject({
        url: '/reader/a/x1?in=all',
        visited: JSON.stringify({ shelf: 'all', ids: ['x0', 'x1'] }),
      });
    });
  });

  describe('a plain launch', () => {
    it('goes back to the last place', async () => {
      const { router } = await coldOpen('/', {
        stored: { [LAST_PLACE_KEY]: { url: '/settings' } },
      });
      expect(router.url).toBe('/settings');
    });

    it('lands on the capture note on a first launch, as before', async () => {
      const { router, capture } = await coldOpen('/');
      expect(router.url).toBe('/');
      expect(capture.open()).toEqual({ id: 'new1', text: '' });
    });

    it('stays on / when / was the place, its capture note resumed', async () => {
      const notes = new FakeNotes();
      const { router, capture, settle } = await coldOpen('/', {
        notes,
        stored: { [LAST_PLACE_KEY]: { url: '/', note: 'n1', saved: true } },
      });
      expect(router.url).toBe('/');
      expect(capture.open().id).toBe('n1');
      notes.signIn([noteRecord('n1', 'half a thought')]);
      await settle();
      expect(router.url).toBe('/');
      expect(capture.current()).toBe('half a thought');
    });

    it('shows sign-in at / on a device not signed in', async () => {
      const { router } = await coldOpen('/', {
        signedIn: false,
        stored: { [LAST_PLACE_KEY]: { url: '/settings' } },
      });
      expect(router.url).toBe('/');
    });

    it('does not restore for a share, a deep link or a notification’s target', async () => {
      const stored = { [LAST_PLACE_KEY]: { url: '/settings' } };
      expect((await coldOpen('/?text=hello', { stored })).router.url).toBe('/?text=hello');
      TestBed.resetTestingModule();
      expect((await coldOpen('/?shared=1', { stored })).router.url).toBe('/?shared=1');
      TestBed.resetTestingModule();
      expect((await coldOpen('/share?text=hi&at=1', { stored })).router.url).toBe(
        '/share?text=hi&at=1',
      );
      TestBed.resetTestingModule();
      expect((await coldOpen('/n/n2', { stored })).router.url).toBe('/n/n2');
      TestBed.resetTestingModule();
      expect((await coldOpen('/n/n2?from=reminder', { stored })).router.url).toBe(
        '/n/n2?from=reminder',
      );
    });

    it('does not bounce an in-app move to the capture screen', async () => {
      const { router, settle } = await coldOpen('/home', {
        stored: { [LAST_PLACE_KEY]: { url: '/settings' } },
      });
      // The Home box, New note, or any link to /.
      await router.navigateByUrl('/');
      await settle();
      expect(router.url).toBe('/');
    });

    it('follows Start on when another screen is chosen there (#219)', async () => {
      const { router } = await coldOpen('/', {
        stored: {
          [LAST_PLACE_KEY]: { url: '/settings' },
          [START_ON_KEY]: { choice: 'home' },
        },
      });
      expect(router.url).toBe('/home');
    });

    it('puts an article’s run through its shelf back in a new tab, not over this tab’s', async () => {
      const visited = JSON.stringify({ shelf: 'all', ids: ['x0', 'x1'] });
      const modules = new FakeModules();
      modules.set('reader', true);
      const { router } = await coldOpen('/', {
        modules,
        stored: { [LAST_PLACE_KEY]: { url: '/reader/a/x1?in=all', top: 500, visited } },
      });
      expect(router.url).toBe('/reader/a/x1?in=all');
      expect(sessionStorage.getItem(VISITED_KEY)).toBe(visited);
    });
  });

  describe('the scroll', () => {
    it('waits for the content, then puts it back once, and remembers again after', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { router, place, stored, settle } = await coldOpenWithSource('/n/n1', {
        top: 1200,
        caret: 40,
      });
      expect(router.url).toBe('/n/n1');
      const { state } = current!;
      // Not there yet: nothing applied, and the place kept is untouched.
      vi.advanceTimersByTime(RESTORE_EVERY_MS * 5);
      expect(state.applied).toEqual([]);
      window.dispatchEvent(new Event('pagehide'));
      expect(stored()).toEqual({ url: '/n/n1', top: 1200, caret: 40 });
      state.ready = true;
      vi.advanceTimersByTime(RESTORE_EVERY_MS);
      expect(state.applied).toEqual([{ url: '/n/n1', top: 1200, caret: 40 }]);
      // More loading later moves nothing.
      vi.advanceTimersByTime(RESTORE_EVERY_MS * 10);
      expect(state.applied).toHaveLength(1);
      state.spot = { top: 1300, caret: 41 };
      window.dispatchEvent(new Event('pagehide'));
      expect(stored()).toEqual({ url: '/n/n1', top: 1300, caret: 41 });
      await settle();
      void place;
    });

    it('is put back too when the app opens cold at the place’s own address', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await coldOpenWithSource('/n/n1', { top: 800 }, '/n/n1');
      const { state } = current!;
      state.ready = true;
      vi.advanceTimersByTime(RESTORE_EVERY_MS);
      expect(state.applied).toEqual([{ url: '/n/n1', top: 800 }]);
    });

    it('lets him win: a scroll, tap or key of his own first stops it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        TestBed.resetTestingModule();
        await coldOpenWithSource('/n/n1', { top: 1200 });
        const { state } = current!;
        document.dispatchEvent(new Event(type));
        state.ready = true;
        vi.advanceTimersByTime(RESTORE_EVERY_MS * 5);
        expect(state.applied).toEqual([]);
      }
    });

    it('gives up after a while rather than jump late', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await coldOpenWithSource('/n/n1', { top: 1200 });
      const { state } = current!;
      vi.advanceTimersByTime(RESTORE_EVERY_MS * RESTORE_TRIES);
      state.ready = true;
      vi.advanceTimersByTime(RESTORE_EVERY_MS * 5);
      expect(state.applied).toEqual([]);
    });
  });

  describe('a place that has gone falls back to Home', () => {
    it('a note since deleted', async () => {
      const notes = new FakeNotes();
      const { router, settle } = await coldOpen('/', {
        notes,
        stored: { [LAST_PLACE_KEY]: { url: '/n/n1' } },
      });
      expect(router.url).toBe('/n/n1');
      notes.signIn([noteRecord('n2', 'another')]);
      await settle();
      expect(router.url).toBe('/home');
    });

    it('a note in Trash', async () => {
      const notes = new FakeNotes();
      const { router, settle } = await coldOpen('/', {
        notes,
        stored: { [LAST_PLACE_KEY]: { url: '/n/n1' } },
      });
      notes.trash.set([noteRecord('n1', 'deleted on the laptop')]);
      notes.signIn([]);
      await settle();
      expect(router.url).toBe('/home');
    });

    it('a sealed note locked on this device', async () => {
      const notes = new FakeNotes();
      const { router, settle } = await coldOpen('/', {
        notes,
        stored: { [LAST_PLACE_KEY]: { url: '/n/n1' } },
      });
      notes.signIn([{ ...noteRecord('n1', ''), locked: true }]);
      await settle();
      expect(router.url).toBe('/home');
    });

    it('a module turned off, as this device last knew it, or once read', async () => {
      const { router } = await coldOpen('/', { stored: { [LAST_PLACE_KEY]: { url: '/kitchen' } } });
      expect(router.url).toBe('/home');
      TestBed.resetTestingModule();
      // Known on when last read here, off by the time the doc is read.
      const modules = new FakeModules();
      modules.loaded.set(false);
      const again = await coldOpen('/', {
        modules,
        stored: {
          [LAST_PLACE_KEY]: { url: '/kitchen' },
          [START_ON_KEY]: { choice: 'note', kitchen: true },
        },
      });
      expect(again.router.url).toBe('/kitchen');
      modules.loaded.set(true);
      await again.settle();
      expect(again.router.url).toBe('/home');
    });

    it('the capture note left at /, saved and since gone: Home, and a fresh capture note', async () => {
      const notes = new FakeNotes();
      const { router, capture, settle } = await coldOpen('/', {
        notes,
        stored: { [LAST_PLACE_KEY]: { url: '/', note: 'n1', saved: true } },
      });
      notes.signIn([]);
      await settle();
      expect(router.url).toBe('/home');
      expect(capture.home()).not.toBe('n1');
    });

    it('but never over words typed in it meanwhile', async () => {
      const notes = new FakeNotes();
      const { router, capture, settle } = await coldOpen('/', {
        notes,
        stored: { [LAST_PLACE_KEY]: { url: '/', note: 'n1', saved: true } },
      });
      capture.onText('typed before the notes came');
      notes.signIn([]);
      await settle();
      expect(router.url).toBe('/');
      expect(capture.open().id).toBe('n1');
    });

    it('and never over a draft from before, which is picked up as always', async () => {
      const notes = new FakeNotes();
      const { router, capture, settle } = await coldOpen('/', {
        notes,
        stored: {
          [PENDING_DRAFT_KEY]: { id: 'd1', body: 'unsaved words' },
          [LAST_PLACE_KEY]: { url: '/', note: 'n1', saved: true },
        },
      });
      expect(capture.open().id).toBe('d1');
      notes.signIn([]);
      await settle();
      expect(router.url).toBe('/');
      expect(notes.save).toHaveBeenCalledWith('d1', 'unsaved words');
    });

    it('a draft is written wherever the launch lands', async () => {
      const notes = new FakeNotes();
      const { router, settle } = await coldOpen('/', {
        notes,
        stored: {
          [PENDING_DRAFT_KEY]: { id: 'd1', body: 'typed before the notes loaded' },
          [LAST_PLACE_KEY]: { url: '/settings' },
        },
      });
      expect(router.url).toBe('/settings');
      notes.signIn([]);
      await settle();
      expect(notes.save).toHaveBeenCalledWith('d1', 'typed before the notes loaded');
    });

    it('stays when he has moved on before the notes came', async () => {
      const notes = new FakeNotes();
      const { router, settle } = await coldOpen('/', {
        notes,
        stored: { [LAST_PLACE_KEY]: { url: '/n/n1' } },
      });
      await router.navigateByUrl('/settings');
      await settle();
      notes.signIn([]);
      await settle();
      expect(router.url).toBe('/settings');
    });

    it('a note the stale cache still had, found in Trash once the server answers', async () => {
      const notes = new FakeNotes();
      const { router, settle } = await coldOpen('/', {
        notes,
        stored: { [LAST_PLACE_KEY]: { url: '/n/n1' } },
      });
      notes.signIn([noteRecord('n1', 'deleted on the laptop')]);
      await settle();
      expect(router.url).toBe('/n/n1');
      notes.notes.set([]);
      notes.trash.set([noteRecord('n1', 'deleted on the laptop')]);
      await settle();
      expect(router.url).toBe('/home');
    });

    it('not once he has tapped, scrolled or typed: the screen then says what it says', async () => {
      const notes = new FakeNotes();
      const { router, settle } = await coldOpen('/', {
        notes,
        stored: { [LAST_PLACE_KEY]: { url: '/n/n1' } },
      });
      notes.signIn([noteRecord('n1', 'here for now')]);
      await settle();
      document.dispatchEvent(new Event('pointerdown'));
      notes.notes.set([]);
      notes.trash.set([noteRecord('n1', 'here for now')]);
      await settle();
      expect(router.url).toBe('/n/n1');
    });

    it('a note still there stays open', async () => {
      const notes = new FakeNotes();
      const { router, settle } = await coldOpen('/', {
        notes,
        stored: { [LAST_PLACE_KEY]: { url: '/n/n1' } },
      });
      notes.signIn([noteRecord('n1', 'still here')]);
      await settle();
      expect(router.url).toBe('/n/n1');
    });
  });
});

let current: ReturnType<typeof fakeSource> | undefined;

/**
 * A cold open of `/` going back to `url`, its screen scrolling in a
 * source of its own, registered as the screen is made (before the
 * navigation ends), as the launch screen does.
 */
async function coldOpenWithSource(url: string, spot: Spot, openAt = '/') {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(SIGNED_IN_KEY, 'true');
  localStorage.setItem(LAST_PLACE_KEY, JSON.stringify({ url, ...spot }));
  const notes = new FakeNotes();
  notes.signIn([noteRecord('n1', 'a long note')]);
  current = fakeSource();
  const made = current;
  @Component({ template: 'a note' })
  class Scrolling {
    constructor() {
      TestBed.inject(LastPlaceService).register(made.source);
    }
  }
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: '', component: Here, canActivate: [startOnGuard] },
        { path: 'n/:id', component: Scrolling },
        { path: 'home', component: Here },
      ]),
      { provide: NotesService, useValue: notes },
      { provide: ModulesService, useValue: new FakeModules() },
    ],
  });
  const place = TestBed.inject(LastPlaceService);
  const harness = await RouterTestingHarness.create(openAt);
  const stored = () => JSON.parse(localStorage.getItem(LAST_PLACE_KEY) ?? 'null');
  const settle = async () => {
    TestBed.tick();
    await harness.fixture.whenStable();
  };
  return { router: TestBed.inject(Router), place, stored, settle };
}
