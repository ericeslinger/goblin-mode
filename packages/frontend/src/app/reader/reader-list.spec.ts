import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW } from '../platform/platform';
import { ReadingService } from '../reading/reading.service';
import {
  FakeDownloadsApi,
  FakeItemsApi,
  FakeModules,
  FakeNotes,
  FakeReaderApi,
  FakeSettingsApi,
  fakeFirebase,
} from '../testing/fakes';
import { SETTINGS_API } from '../theme/theme-sync.service';
import { DOWNLOADS_API } from './downloads.service';
import { ITEMS_API, ItemsService } from './items.service';
import { PASSED_MS, ReaderList, SETTLE_MS, UNDO_MS, tabOf } from './reader-list';
import { READER_API } from './reader.service';

const NOW_MS = Date.parse('2026-11-07T12:00:00Z');

const item = (id: string, hoursAgo: number) => ({
  id,
  data: {
    feedId: 'f1',
    title: `Article ${id}`,
    link: `https://x.test/${id}`,
    published: { toMillis: () => NOW_MS - hoursAgo * 3_600_000 },
    summary: '',
    content: '',
    read: false,
    saved: false,
  },
});

/** The observer the list makes, so a spec can say a row left above the top. */
let seen: (entries: Partial<IntersectionObserverEntry>[]) => void;
/** Rows observed and not yet reported: the observer's first look is still to come. */
let fresh: Element[];

function setup(readOnScroll: boolean, folder?: string) {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: typeof seen) {
        seen = cb;
        fresh = [];
      }
      observe(el: Element) {
        fresh.push(el);
      }
      unobserve(el: Element) {
        fresh = fresh.filter((f) => f !== el);
      }
      disconnect() {}
    },
  );
  const api = new FakeItemsApi();
  const feeds = new FakeReaderApi();
  const settings = new FakeSettingsApi();
  const modules = new FakeModules();
  modules.set('reader', true);
  TestBed.configureTestingModule({
    imports: [ReaderList],
    providers: [
      provideRouter([]),
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: ITEMS_API, useValue: api },
      { provide: NotesService, useValue: new FakeNotes() },
      { provide: ReadingService, useValue: { save: vi.fn() } },
      { provide: READER_API, useValue: feeds },
      { provide: SETTINGS_API, useValue: settings },
      { provide: ModulesService, useValue: modules },
      { provide: DOWNLOADS_API, useValue: new FakeDownloadsApi() },
      { provide: AuthService, useValue: { user: signal<User | null>({ uid: 'u1' } as User) } },
      { provide: NOW, useValue: () => NOW_MS },
      ...(folder
        ? [{ provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ folder })) } }]
        : []),
    ],
  });
  const items = TestBed.inject(ItemsService);
  TestBed.tick();
  feeds.push([{ id: 'f1', data: { url: 'https://a.test/f', title: 'Blog', folders: ['Design'] } }]);
  settings.push({ folderOrder: [], images: true, readOnScroll, updatedAt: 1 });
  api.push('unread', [item('a', 1), item('b', 2), item('c', 3)]);
  const fixture = TestBed.createComponent(ReaderList);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const row = (id: string) => el.querySelector<HTMLElement>(`li[data-id="${id}"]`)!;
  const entry = (target: Element, above: boolean): Partial<IntersectionObserverEntry> => ({
    target,
    isIntersecting: !above,
    boundingClientRect: { bottom: above ? -4 : 40 } as DOMRectReadOnly,
    rootBounds: { top: 0 } as DOMRectReadOnly,
  });
  const leave = (id: string) => seen([entry(row(id), true)]);
  const back = (id: string) => seen([entry(row(id), false)]);
  /**
   * The observer's first look at the rows it was just given: those with
   * their ids in `above` are above the top, the rest on screen.
   */
  const look = (...above: string[]) => {
    const els = fresh;
    fresh = [];
    seen(els.map((el) => entry(el, above.includes((el as HTMLElement).dataset['id']!))));
  };
  const status = () =>
    el.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, ' ').trim();
  /** The gardener moves the page, as a finger does: a touch, then a scroll. */
  const move = () => {
    window.dispatchEvent(new Event('touchmove'));
    window.dispatchEvent(new Event('scroll'));
  };
  return { fixture, el, items, api, feeds, settings, leave, back, look, move, status };
}

describe('ReaderList, mark read on scroll (#172)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('marks rows that stayed above the top in one batch once still, holds them, and undoes', () => {
    const { fixture, el, items, api, leave, back, look, move, status } = setup(true);
    look();
    move();
    expect(el.querySelectorAll('li')).toHaveLength(3);
    leave('a');
    leave('b');
    // b comes back before its moment is up: only a counts.
    vi.advanceTimersByTime(PASSED_MS / 2);
    back('b');
    vi.advanceTimersByTime(PASSED_MS + SETTLE_MS);
    fixture.detectChanges();
    expect(api.setMany).toHaveBeenCalledTimes(1);
    expect(api.setMany.mock.lastCall![1].map((w) => w.path)).toEqual(['users/u1/feedItems/a']);
    expect(items.unreadCounts()['all']).toBe(2);
    // Held in the list, greyed, so nothing moves.
    expect(el.querySelectorAll('li')).toHaveLength(3);
    expect(el.querySelector('li[data-id="a"]')!.classList).toContain('read');
    expect(status()).toBe('Marked 1 read. Undo');
    el.querySelector<HTMLButtonElement>('[role="status"] button')!.click();
    fixture.detectChanges();
    expect(api.setMany.mock.lastCall![1][0].data).toEqual({
      read: false,
      readAt: 'CLEAR',
      updatedAt: 'SERVER_TIME',
    });
    expect(items.unreadCounts()['all']).toBe(3);
    expect(status()).toBe('1 unread again.');
  });

  it('waits for the page to be still, and takes the Undo offer back after a while', () => {
    const { fixture, api, leave, look, move, status } = setup(true);
    look();
    move();
    leave('a');
    vi.advanceTimersByTime(PASSED_MS);
    // Still scrolling: the batch waits.
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SETTLE_MS - 50);
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SETTLE_MS - 50);
    expect(api.setMany).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(api.setMany).toHaveBeenCalledTimes(1);
    fixture.detectChanges();
    expect(status()).toBe('Marked 1 read. Undo');
    vi.advanceTimersByTime(UNDO_MS);
    fixture.detectChanges();
    expect(status()).toBe('Marked 1 read.');
  });

  it('marks nothing a reload or Back put above the top until the page is moved (review on #182)', () => {
    const { api, leave, look, move } = setup(true);
    // The observer's first look finds a above the top, where a reload left it.
    look('a');
    // The browser restores the scroll: b goes above too.
    leave('b');
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(PASSED_MS + SETTLE_MS);
    expect(api.setMany).not.toHaveBeenCalled();
    // The gardener moves the page: b, which went above after the first
    // look, now counts; a was never seen go (#172).
    move();
    vi.advanceTimersByTime(PASSED_MS + SETTLE_MS);
    expect(api.setMany).toHaveBeenCalledTimes(1);
    expect(api.setMany.mock.lastCall![1].map((w) => w.path)).toEqual(['users/u1/feedItems/b']);
  });

  it('after Undo, marks no row the list put back above the top until it is scrolled past again (#172)', () => {
    const { fixture, el, api, leave, back, look, move } = setup(true);
    look();
    move();
    leave('a');
    leave('b');
    vi.advanceTimersByTime(PASSED_MS + SETTLE_MS);
    fixture.detectChanges();
    expect(api.setMany).toHaveBeenCalledTimes(1);
    el.querySelector<HTMLButtonElement>('[role="status"] button')!.click();
    fixture.detectChanges();
    expect(api.setMany).toHaveBeenCalledTimes(2);
    // The listeners echo the Undo one shelf at a time: a and b leave the
    // list and come back as new rows, and the observer's first look
    // finds them above the top.
    api.push('unread', [item('c', 3)]);
    fixture.detectChanges();
    api.push('unread', [item('a', 1), item('b', 2), item('c', 3)]);
    fixture.detectChanges();
    look('a', 'b');
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(PASSED_MS + SETTLE_MS);
    expect(api.setMany).toHaveBeenCalledTimes(2);
    // The gardener scrolls back up past them, then down again: now they count.
    window.dispatchEvent(new Event('wheel'));
    window.dispatchEvent(new Event('scroll'));
    back('a');
    back('b');
    leave('a');
    leave('b');
    vi.advanceTimersByTime(PASSED_MS + SETTLE_MS);
    expect(api.setMany).toHaveBeenCalledTimes(3);
    expect(api.setMany.mock.lastCall![1].map((w) => w.path)).toEqual([
      'users/u1/feedItems/a',
      'users/u1/feedItems/b',
    ]);
  });

  it('marks no row a re-render puts above the top while the page is moving (#172)', () => {
    const { fixture, el, api, look, move } = setup(true);
    look();
    move();
    // A new list from the listener: a and b leave and come back as new
    // rows above the top, with d new at the head.
    api.push('unread', [item('c', 3)]);
    fixture.detectChanges();
    api.push('unread', [item('d', 0.5), item('a', 1), item('b', 2), item('c', 3)]);
    fixture.detectChanges();
    expect(el.querySelectorAll('li')).toHaveLength(4);
    look('d', 'a', 'b');
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(PASSED_MS + SETTLE_MS);
    expect(api.setMany).not.toHaveBeenCalled();
  });

  it('marks nothing with the switch off', () => {
    const { api, leave, look, move } = setup(false);
    look();
    move();
    leave('a');
    vi.advanceTimersByTime(PASSED_MS + SETTLE_MS);
    expect(api.setMany).not.toHaveBeenCalled();
  });
});

describe('ReaderList, a folder seen (#173)', () => {
  it('notes a folder as seen when its list opens, once, so nothing in it is new', () => {
    const { fixture, items, settings } = setup(false, 'Design');
    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set.mock.lastCall![2]['seenAt']).toEqual({ Design: NOW_MS });
    expect(items.newSince()).toEqual([]);
    fixture.detectChanges();
    expect(settings.set).toHaveBeenCalledTimes(1);
  });

  it('notes nothing for All', () => {
    const { settings } = setup(false);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('notes nothing for a shelf that is no folder of the feeds', () => {
    const { settings } = setup(false, 'Listening');
    expect(settings.set).not.toHaveBeenCalled();
  });
});

describe('ReaderList, under the Reader tabs (#220)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the tab each shelf is, or is under', () => {
    expect(tabOf({ kind: 'folder', name: 'all' })).toBe('all');
    expect(tabOf({ kind: 'folder', name: 'saved' })).toBe('saved');
    // The Podcasts shelf left for a module of its own (#245).
    expect(tabOf({ kind: 'folder', name: 'podcasts' })).toBe('folders');
    expect(tabOf({ kind: 'folder', name: 'Design' })).toBe('folders');
    expect(tabOf({ kind: 'feed', id: 'f1' })).toBe('folders');
  });

  it('lists no episode of a show in Podcasts, and has no Podcasts tab (#245)', () => {
    const { el, api, feeds, fixture } = setup(false);
    feeds.push([
      { id: 'f1', data: { url: 'https://a.test/f', title: 'Blog', folders: ['Design'] } },
      {
        id: 'p1',
        data: { url: 'https://p.test/f', title: 'Kiln talk', folders: ['Design'], kind: 'podcast' },
      },
    ]);
    api.push('unread', [
      item('a', 1),
      { id: 'e1', data: { ...item('e1', 2).data, feedId: 'p1', title: 'An episode' } },
    ]);
    fixture.detectChanges();
    const tabs = el.querySelector('nav[aria-label="Reader screens"]')!;
    expect(
      [...tabs.querySelectorAll('a')].map((a) => a.textContent!.trim().split(/\s/)[0]),
    ).toEqual(['All', 'Saved', 'Folders']);
    expect(tabs.querySelector('a')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('All 1 unread');
    expect(el.querySelector('li[data-id="a"]')).not.toBeNull();
    expect(el.querySelector('li[data-id="e1"]')).toBeNull();
    expect(el.textContent).not.toContain('An episode');
  });

  it('opens on All, its tab the page, with the unread count in it', () => {
    const { el } = setup(false);
    const tabs = el.querySelector('nav[aria-label="Reader screens"]')!;
    const current = tabs.querySelector('a[aria-current]')!;
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.textContent!.replace(/\s+/g, ' ').trim()).toBe('All 3 unread');
    expect(el.querySelector('a[href="/reader/folders"]:not(nav a)')).toBeNull();
  });

  it("draws a folder's shelf under Folders, with the way back and its name", () => {
    const { el } = setup(false, 'Design');
    const tabs = el.querySelector('nav[aria-label="Reader screens"]')!;
    const current = tabs.querySelector('a[aria-current]')!;
    expect(current.textContent!.trim()).toBe('Folders');
    expect(current.getAttribute('aria-current')).toBe('true');
    expect(el.querySelector('a.up')!.getAttribute('href')).toBe('/reader/folders');
    expect(el.querySelector('h2')!.textContent).toBe('Design');
    // Icon-only controls carry names (#221).
    for (const name of ['Search articles', 'Manage feeds']) {
      expect(el.querySelector(`[aria-label="${name}"]`)).not.toBeNull();
    }
  });
});
