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
import { ReaderPanes, panesFolders, panesPlace } from './reader-panes';
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
    for (const other of [
      segs('reader', 'folders'),
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

  it('starts from a width with room for the rail, the folders, the list and a measure', () => {
    // 176 + 192 + 352 + 70 characters at 16 px (560) and 16 px either side.
    expect(READER_PANES_MIN).toBeGreaterThanOrEqual(176 + 192 + 352 + 560 + 32);
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
    await router.navigateByUrl('/reader/folders');
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
  });
});

describe('panesFolders (#289)', () => {
  const folders = [{ name: 'Design' }, { name: 'Games' }];
  it('lists All, Saved and the folders with their unread, the shelf shown current', () => {
    const list = panesFolders(
      folders,
      { all: 5, Design: 3, Games: 2 },
      {
        kind: 'folder',
        name: 'Design',
      },
    );
    expect(list.map((f) => [f.name, f.count, f.current])).toEqual([
      ['All', 5, false],
      ['Saved', 0, false],
      ['Design', 3, true],
      ['Games', 2, false],
    ]);
    expect(list[1].link).toEqual(['/reader/f', 'saved']);
    expect(
      panesFolders(folders, {}, { kind: 'folder', name: 'saved' }).filter((f) => f.current),
    ).toHaveLength(1);
    expect(panesFolders(folders, {}, { kind: 'feed', id: 'f1' }).some((f) => f.current)).toBe(
      false,
    );
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

  it('draws the folders, the list and an empty article pane on a list', async () => {
    const { el } = await panes('/reader/f/Design');
    expect(el().querySelectorAll('main')).toHaveLength(1);
    expect(el().querySelectorAll('h1')).toHaveLength(1);
    const nav = el().querySelector('nav[aria-label="Folders"]')!;
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent!.trim())).toEqual([
      'All 4 unread',
      'Saved',
      'Design 3 unread',
      'Games 1 unread',
    ]);
    expect(nav.querySelector('[aria-current="page"]')!.textContent).toContain('Design');
    const listPane = el().querySelector('section[aria-label="List of articles"]')!;
    expect(listPane.querySelectorAll('li[data-id]')).toHaveLength(3);
    const article = el().querySelector('section[aria-label="Article"]')!;
    expect(article.textContent!.trim()).toBe('Choose an article');
    // No chips: the folders pane stands for them.
    expect(el().querySelector('nav[aria-label="By folder"]')).toBeNull();
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

  it('filters the list by a folder from the folders pane', async () => {
    const { harness, el } = await panes('/reader');
    expect(el().querySelectorAll('li[data-id]')).toHaveLength(4);
    el()
      .querySelector<HTMLAnchorElement>('nav[aria-label="Folders"] a[href="/reader/f/Games"]')!
      .click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Location).path()).toBe('/reader/f/Games');
    expect(el().querySelectorAll('li[data-id]')).toHaveLength(1);
  });
});
