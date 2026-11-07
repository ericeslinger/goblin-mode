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
  FakeItemsApi,
  FakeModules,
  FakeNotes,
  FakeReaderApi,
  FakeSettingsApi,
  fakeFirebase,
} from '../testing/fakes';
import { SETTINGS_API } from '../theme/theme-sync.service';
import { ITEMS_API, ItemsService } from './items.service';
import { PASSED_MS, ReaderList, SETTLE_MS, UNDO_MS } from './reader-list';
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

function setup(readOnScroll: boolean, folder?: string) {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: typeof seen) {
        seen = cb;
      }
      observe() {}
      unobserve() {}
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
  const leave = (id: string) =>
    seen([
      {
        target: row(id),
        isIntersecting: false,
        boundingClientRect: { bottom: -4 } as DOMRectReadOnly,
        rootBounds: { top: 0 } as DOMRectReadOnly,
      },
    ]);
  const back = (id: string) =>
    seen([
      {
        target: row(id),
        isIntersecting: true,
        boundingClientRect: { bottom: 40 } as DOMRectReadOnly,
        rootBounds: { top: 0 } as DOMRectReadOnly,
      },
    ]);
  const status = () =>
    el.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, ' ').trim();
  /** The gardener moves the page, as a finger does: a touch, then a scroll. */
  const move = () => {
    window.dispatchEvent(new Event('touchmove'));
    window.dispatchEvent(new Event('scroll'));
  };
  return { fixture, el, items, api, settings, leave, back, move, status };
}

describe('ReaderList, mark read on scroll (#172)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('marks rows that stayed above the top in one batch once still, holds them, and undoes', () => {
    const { fixture, el, items, api, leave, back, move, status } = setup(true);
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
    const { fixture, api, leave, move, status } = setup(true);
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
    const { api, leave, move } = setup(true);
    // The observer's first look finds rows above the top, scrolled there by the browser.
    leave('a');
    leave('b');
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(PASSED_MS + SETTLE_MS);
    expect(api.setMany).not.toHaveBeenCalled();
    // The gardener moves the page: the rows still above now count.
    move();
    vi.advanceTimersByTime(PASSED_MS + SETTLE_MS);
    expect(api.setMany).toHaveBeenCalledTimes(1);
    expect(api.setMany.mock.lastCall![1].map((w) => w.path)).toEqual([
      'users/u1/feedItems/a',
      'users/u1/feedItems/b',
    ]);
  });

  it('marks nothing with the switch off', () => {
    const { api, leave, move } = setup(false);
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
    const { settings } = setup(false, 'podcasts');
    expect(settings.set).not.toHaveBeenCalled();
  });
});
