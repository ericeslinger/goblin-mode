import { Location } from '@angular/common';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, UrlSegment, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW, TIME_ZONE } from '../platform/platform';
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
import {
  PanesWidth,
  READER_PANES_MIN,
  READER_PANES_QUERY,
  panesWide,
  readerPanesMatcher,
} from './panes-route';
import { ReaderList } from './reader-list';
import { ReaderPanes, panesPlace } from './reader-panes';
import { READER_API } from './reader.service';

const NOW_MS = Date.parse('2026-11-07T12:00:00Z');

const item = (id: string, hoursAgo: number, feedId = 'f1') => ({
  id,
  data: {
    feedId,
    title: `Article ${id}`,
    link: `https://x.test/${id}`,
    published: { toMillis: () => NOW_MS - hoursAgo * 3_600_000 },
    summary: '',
    content: `The text of ${id}.`,
    read: false,
    saved: false,
  },
});

const segs = (...paths: string[]) => paths.map((p) => new UrlSegment(p, {}));

describe('readerPanesMatcher (#289)', () => {
  it('matches the lists, an article and the caught-up page, and nothing else', () => {
    expect(readerPanesMatcher(segs('reader'))).toEqual({ consumed: segs('reader') });
    expect(readerPanesMatcher(segs('reader', 'done'))?.consumed).toHaveLength(2);
    expect(readerPanesMatcher(segs('reader', 'f', 'Design'))?.posParams?.['folder']?.path).toBe(
      'Design',
    );
    expect(readerPanesMatcher(segs('reader', 's', 'abc'))?.posParams?.['feedId']?.path).toBe('abc');
    expect(readerPanesMatcher(segs('reader', 'a', 'x1'))?.posParams?.['id']?.path).toBe('x1');
    // Folders too, since the folders column went to its tab (2026-11-22).
    expect(readerPanesMatcher(segs('reader', 'folders'))?.consumed).toHaveLength(2);
    for (const other of [
      segs('reader', 'feeds'),
      segs('reader', 'downloads'),
      segs('reader', 'f'),
      segs('reader', 'x', 'y'),
      segs('reader', 'a', 'x1', 'more'),
      segs('podcasts'),
      segs(),
    ]) {
      expect(readerPanesMatcher(other)).toBeNull();
    }
  });

  it('starts from a width with room for the rail, the list and a measure (2026-11-22)', () => {
    // 176 + 384 + 70 characters at 16 px (560) and 16 px either side.
    expect(READER_PANES_MIN).toBeGreaterThanOrEqual(176 + 384 + 560 + 32);
    // A 1280 laptop has the panes; an iPad on its side (1194) does not.
    expect(READER_PANES_MIN).toBeLessThanOrEqual(1280);
    expect(READER_PANES_MIN).toBeGreaterThan(1194);
  });
});

@Component({ template: '' })
class Blank {}

describe('panesWide and PanesWidth (#289)', () => {
  let matches = false;
  let changed: (() => void) | undefined;
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === READER_PANES_QUERY && matches,
      media: query,
      addEventListener: (_: string, fn: () => void) => (changed = fn),
      removeEventListener: () => undefined,
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lets the panes match only from the width', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    matches = false;
    expect(TestBed.runInInjectionContext(() => panesWide({}, [], {} as never))).toBe(false);
    matches = true;
    expect(TestBed.runInInjectionContext(() => panesWide({}, [], {} as never))).toBe(true);
  });

  it('takes a Reader address through the router again as the window crosses it', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '**', component: Blank }])],
    });
    const router = TestBed.inject(Router);
    TestBed.inject(PanesWidth);
    await router.navigateByUrl('/reader/a/x1?in=f:Design');
    const navigate = vi.spyOn(router, 'navigateByUrl');
    changed!();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(router.serializeUrl(navigate.mock.lastCall![0] as never)).toBe(
      '/reader/a/x1?in=f:Design',
    );
    expect(navigate.mock.lastCall![1]).toEqual({ onSameUrlNavigation: 'reload', replaceUrl: true });
    // Elsewhere, nothing.
    await router.navigateByUrl('/reader/feeds');
    navigate.mockClear();
    changed!();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('panesPlace (#289)', () => {
  it('reads a list, an article beside the list its in names, and the caught-up page', () => {
    expect(panesPlace([], null)).toEqual({ shelf: { kind: 'folder', name: 'all' }, done: false });
    expect(panesPlace(['f', 'Design'], null)).toEqual({
      shelf: { kind: 'folder', name: 'Design' },
      done: false,
    });
    expect(panesPlace(['s', 'f1'], null).shelf).toEqual({ kind: 'feed', id: 'f1' });
    expect(panesPlace(['a', 'x1'], 'f:Games')).toEqual({
      shelf: { kind: 'folder', name: 'Games' },
      article: 'x1',
      done: false,
    });
    // Opened with no in (a search's hit, a clipping's link): All, as the article page has it.
    expect(panesPlace(['a', 'x1'], null).shelf).toEqual({ kind: 'folder', name: 'all' });
    expect(panesPlace(['done'], 's:f1')).toEqual({ shelf: { kind: 'feed', id: 'f1' }, done: true });
    // The folders in the list pane (2026-11-22), no article beside them.
    expect(panesPlace(['folders'], null)).toEqual({
      shelf: { kind: 'folder', name: 'all' },
      done: false,
      folders: true,
    });
  });
});

describe('ReaderPanes (#289)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  async function panes(url: string) {
    const api = new FakeItemsApi();
    const feeds = new FakeReaderApi();
    const settings = new FakeSettingsApi();
    const modules = new FakeModules();
    modules.set('reader', true);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ matcher: readerPanesMatcher, component: ReaderPanes }]),
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
        { provide: TIME_ZONE, useValue: 'UTC' },
      ],
    });
    TestBed.inject(ItemsService);
    TestBed.tick();
    feeds.push([
      { id: 'f1', data: { url: 'https://a.test/f', title: 'Blog', folders: ['Design'] } },
      { id: 'f2', data: { url: 'https://b.test/f', title: 'Dice', folders: ['Games'] } },
    ]);
    settings.push({ folderOrder: [], images: true, readOnScroll: false, updatedAt: 1 });
    api.push('unread', [item('a', 1), item('b', 2), item('c', 3), item('g', 4, 'f2')]);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, ReaderPanes);
    const el = () => harness.routeNativeElement as HTMLElement;
    const list = () => harness.routeDebugElement!.query(By.directive(ReaderList));
    return { harness, el, list };
  }

  it('draws two panes, the header over the list, and an empty article pane', async () => {
    const { el } = await panes('/reader/f/Design');
    expect(el().querySelectorAll('main')).toHaveLength(1);
    expect(el().querySelectorAll('h1')).toHaveLength(1);
    // No folders column (2026-11-22): the header and tabs top the list pane.
    expect(el().querySelector('nav[aria-label="Folders"]')).toBeNull();
    const side = el().querySelector('.side')!;
    expect(side.querySelector('nav[aria-label="Reader screens"]')).not.toBeNull();
    const listPane = side.querySelector('section[aria-label="List of articles"]')!;
    expect(listPane.querySelectorAll('li[data-id]')).toHaveLength(3);
    // The Folders tab says where he is: the folder's name, current.
    const tab = side.querySelector('nav[aria-label="Reader screens"] a[aria-current]')!;
    expect(tab.textContent!.replace(/\s+/g, ' ').trim()).toBe('Folders: Design');
    expect(tab.querySelector('.named')!.textContent).toBe('Design');
    expect(tab.getAttribute('aria-current')).toBe('true');
    expect(tab.getAttribute('href')).toBe('/reader/folders');
    const article = el().querySelector('section[aria-label="Article"]')!;
    expect(article.parentElement!.classList).toContain('panes');
    expect(article.textContent!.trim()).toBe('Choose an article');
    expect(el().querySelector('nav[aria-label="By folder"]')).toBeNull();
  });

  it('shows the Folders tab plain on All', async () => {
    const { el } = await panes('/reader');
    const tabs = [...el().querySelectorAll('nav[aria-label="Reader screens"] a')];
    expect(tabs.map((a) => a.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'All 4 unread',
      'Saved',
      'Folders',
    ]);
    expect(tabs[0].getAttribute('aria-current')).toBe('page');
  });

  it('opens an article beside the same list, its row current, and moves both with j', async () => {
    const { harness, el, list } = await panes('/reader/f/Design');
    const before = list().componentInstance;
    await harness.navigateByUrl('/reader/a/a?in=f:Design', ReaderPanes);
    // The same list, not drawn again: its place is kept.
    expect(list().componentInstance).toBe(before);
    const article = el().querySelector('section[aria-label="Article"]')!;
    expect(article.querySelector('h2')!.textContent).toBe('Article a');
    // Opened by the gardener: its title takes the focus, as a page arriving would be read.
    await harness.fixture.whenStable();
    expect(document.activeElement).toBe(article.querySelector('h2'));
    expect(el().querySelectorAll('h1')).toHaveLength(1);
    expect(el().querySelector('li.cursor')!.getAttribute('data-id')).toBe('a');
    // Read as it opened, and still in the list.
    expect(el().querySelector('li[data-id="a"]')!.classList).toContain('read');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    await harness.fixture.whenStable();
    expect(TestBed.inject(Location).path()).toBe('/reader/a/b?in=f:Design');
    expect(list().componentInstance).toBe(before);
    expect(el().querySelector('section[aria-label="Article"] h2')!.textContent).toBe('Article b');
    expect(el().querySelector('li.cursor')!.getAttribute('data-id')).toBe('b');
    expect(el().querySelectorAll('li[data-id]')).toHaveLength(3);
    // k goes back along the list as drawn.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    await harness.fixture.whenStable();
    expect(TestBed.inject(Location).path()).toBe('/reader/a/a?in=f:Design');
    // Escape closes the article: the list as it was, the pane empty.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await harness.fixture.whenStable();
    expect(TestBed.inject(Location).path()).toBe('/reader/f/Design');
    expect(list().componentInstance).toBe(before);
    expect(el().querySelector('section[aria-label="Article"]')!.textContent!.trim()).toBe(
      'Choose an article',
    );
    // The list is the screen again: the run is over, and the two read
    // on the way have left it (2026-11-11).
    expect(TestBed.inject(ItemsService).visitedIn({ kind: 'folder', name: 'Design' }).size).toBe(0);
    expect(
      [...el().querySelectorAll('li[data-id]')].map((li) => li.getAttribute('data-id')),
    ).toEqual(['c']);
  });

  it('opens a cold article with its list beside it, and goes on to the caught-up page', async () => {
    const { harness, el } = await panes('/reader/a/c?in=f:Design');
    expect(
      el().querySelectorAll('section[aria-label="List of articles"] li[data-id]'),
    ).toHaveLength(3);
    expect(el().querySelector('li.cursor')!.getAttribute('data-id')).toBe('c');
    // A reload is not the gardener opening it: the focus is left alone.
    expect(document.activeElement?.tagName).not.toBe('H2');
    // The last of the list: Next is the caught-up page, in the pane.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    await harness.fixture.whenStable();
    expect(TestBed.inject(Location).path()).toBe('/reader/done?in=f:Design');
    const pane = el().querySelector('section[aria-label="Article"]')!;
    expect(pane.querySelector('h2')!.textContent).toBe('You are all caught up');
    expect(el().querySelectorAll('h1')).toHaveLength(1);
    expect(el().querySelectorAll('main')).toHaveLength(1);
  });

  it('shows the folders in the list pane; one chosen is the list, its heading focused', async () => {
    const { harness, el, list } = await panes('/reader/folders');
    await harness.fixture.whenStable();
    expect(list()).toBeNull();
    const pane = el().querySelector('section[aria-label="Folders"]')!;
    const links = [...pane.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Folders"] a')];
    expect(links.map((a) => a.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'Design 3 unread',
      'Games 1 unread',
    ]);
    const tab = el().querySelector('nav[aria-label="Reader screens"] a[aria-current]')!;
    expect(tab.textContent!.trim()).toBe('Folders');
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(el().querySelector('section[aria-label="Article"]')!.textContent!.trim()).toBe(
      'Choose an article',
    );
    // The link pressed goes with the folders, so the list's heading takes the focus.
    links[1].focus();
    links[1].click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Location).path()).toBe('/reader/f/Games');
    expect(el().querySelectorAll('li[data-id]')).toHaveLength(1);
    const heading = el().querySelector('section[aria-label="List of articles"] h2')!;
    expect(heading.textContent).toBe('Games');
    expect(document.activeElement).toBe(heading);
    expect(
      el().querySelector('nav[aria-label="Reader screens"] a[aria-current] .named')!.textContent,
    ).toBe('Games');
    // Back to them by the list's own link: their heading takes the focus.
    const up = el().querySelector<HTMLAnchorElement>('a.up')!;
    up.focus();
    up.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Location).path()).toBe('/reader/folders');
    expect(document.activeElement!.textContent).toBe('Folders');
    expect(document.activeElement!.tagName).toBe('H2');
  });

  it('leaves the focus alone on a list drawn with the panes (a reload)', async () => {
    const { harness } = await panes('/reader/f/Games');
    await harness.fixture.whenStable();
    expect(document.activeElement?.tagName).not.toBe('H2');
  });
});
