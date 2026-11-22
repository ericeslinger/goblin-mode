import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { ACTIVITY_API } from '../claude/activity';
import { ProposalsService } from '../claude/proposals.service';
import { FIREBASE } from '../firebase';
import { Home } from '../home/home';
import { PlacesService, placeLabel } from '../home/places';
import { GroceryService } from '../kitchen/grocery.service';
import { ModulesService } from '../modules/modules.service';
import { type NoteRecord, NotesService } from '../notes/notes.service';
import { NOW } from '../platform/platform';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { PlayerService } from '../reader/player.service';
import { ReaderService } from '../reader/reader.service';
import { ReadingService } from '../reading/reading.service';
import { RemindersService } from '../reminders/reminders.service';
import {
  FakeAuthService,
  FakeItems,
  FakeModules,
  FakeNotes,
  FakeProposals,
  FakeReader,
  fakeFirebase,
  noteRecord,
} from '../testing/fakes';
import { STORAGE } from '../platform/platform';
import {
  OPENED_AT,
  RAIL_CLASS,
  RAIL_ICONS_CLASS,
  RAIL_KEY,
  Rail,
  RailNav,
  currentPlace,
  offRail,
} from './rail';

@Component({ template: '' })
class Blank {}

interface Setup {
  signedIn?: boolean | 'restoring';
  kitchen?: boolean;
  reader?: boolean;
  due?: string[];
  notes?: NoteRecord[];
  listId?: string;
  /** The window's width, for the media queries; 1440 unless given. */
  width?: number;
}

const episode = (id: string, more: Partial<ItemRecord> = {}): ItemRecord => ({
  id,
  feedId: 'p1',
  title: id,
  link: '',
  published: 0,
  summary: '',
  content: '',
  read: false,
  saved: false,
  ...more,
});

function configure(setup: Setup = {}) {
  localStorage.clear();
  const auth = new FakeAuthService();
  if (setup.signedIn === 'restoring') {
    auth.user.set(undefined);
    auth.signedInBefore.set(true);
  } else if (setup.signedIn ?? true) {
    auth.user.set({ uid: 'u1', email: 'eric@example.com' } as User);
  }
  const notes = new FakeNotes();
  notes.signIn(setup.notes ?? []);
  const modules = new FakeModules();
  if (setup.kitchen) modules.set('kitchen', true);
  if (setup.reader) modules.set('reader', true);
  const items = new FakeItems();
  items.unreadCounts.set({ all: 179, saved: 0 });
  items.episodes.set([episode('e1'), episode('e2'), episode('e3', { read: true, played: true })]);
  const proposals = new FakeProposals();
  proposals.list.set([{ id: 'p1', status: 'open' } as never]);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: (setup.width ?? 1440) >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: Blank }]),
      { provide: AuthService, useValue: auth },
      { provide: NotesService, useValue: notes },
      { provide: ModulesService, useValue: modules },
      { provide: ItemsService, useValue: items },
      { provide: ReaderService, useValue: new FakeReader() },
      {
        provide: PlayerService,
        useValue: {
          item: signal(undefined),
          playing: signal(false),
          position: signal(0),
          duration: signal(0),
        },
      },
      { provide: ProposalsService, useValue: proposals },
      { provide: ReadingService, useValue: { unread: signal([{}, {}, {}]) } },
      {
        provide: RemindersService,
        useValue: {
          due: signal((setup.due ?? []).map((text, i) => ({ id: `${i}`, text }))),
        },
      },
      {
        provide: GroceryService,
        useValue: {
          listId: signal(setup.listId),
          isList: (n: NoteRecord) => n.id === setup.listId,
        },
      },
      {
        provide: ACTIVITY_API,
        useValue: {
          listen: (_db: unknown, _path: string, next: (docs: never[]) => void) => {
            next([]);
            return () => undefined;
          },
        },
      },
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: NOW, useValue: () => new Date(2026, 10, 16, 18).getTime() },
    ],
  });
  return { auth, modules };
}

async function nav(url: string, setup: Setup = {}) {
  configure(setup);
  const fixture = TestBed.createComponent(RailNav);
  fixture.componentRef.setInput('url', url);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

const links = (el: HTMLElement) => [...el.querySelectorAll<HTMLAnchorElement>('nav a')];
const names = (el: HTMLElement) => links(el).map((a) => a.querySelector('.name')?.textContent);
const current = (el: HTMLElement) =>
  links(el)
    .filter((a) => a.getAttribute('aria-current') === 'page')
    .map((a) => a.querySelector('.name')?.textContent);
const entry = (el: HTMLElement, name: string) =>
  links(el).find((a) => a.querySelector('.name')?.textContent === name)!;

describe('the rail (#289)', () => {
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    document.documentElement.classList.remove(RAIL_CLASS, RAIL_ICONS_CLASS);
  });

  it('lists the places in order, Settings last, a module that is off left out', async () => {
    let el = await nav('/home');
    expect(names(el)).toEqual([
      'Home',
      'Notes',
      'Right Now',
      'Reading queue',
      'Map',
      'Assistants',
      'Settings',
    ]);
    TestBed.resetTestingModule();
    el = await nav('/home', { kitchen: true, reader: true });
    // Podcasts follows the Reader until switched itself (#245).
    expect(names(el)).toEqual([
      'Home',
      'Notes',
      'Right Now',
      'Kitchen',
      'Reader',
      'Podcasts',
      'Reading queue',
      'Map',
      'Assistants',
      'Settings',
    ]);
    expect(entry(el, 'Settings').classList).toContain('foot');
    expect(entry(el, 'Notes').getAttribute('href')).toBe('/browse');
    expect(entry(el, 'Right Now').getAttribute('href')).toBe('/right-now');
    expect(entry(el, 'Assistants').getAttribute('href')).toBe('/activity');
  });

  it('names each count with what it counts, and shows none for nothing', async () => {
    const el = await nav('/home', { reader: true, due: ['Pick up glazed mugs', 'Stamps'] });
    expect(entry(el, 'Right Now').getAttribute('aria-label')).toBe('Right Now, 2 due');
    expect(entry(el, 'Reader').getAttribute('aria-label')).toBe('Reader, 179 unread');
    expect(entry(el, 'Podcasts').getAttribute('aria-label')).toBe('Podcasts, 2 new');
    expect(entry(el, 'Reading queue').getAttribute('aria-label')).toBe('Reading queue, 3 to read');
    expect(entry(el, 'Assistants').getAttribute('aria-label')).toBe('Assistants, 1 suggestion');
    expect(entry(el, 'Reader').querySelector('.count')?.textContent).toBe('179');
    // Nothing counted: the name alone, and no number drawn.
    expect(entry(el, 'Map').getAttribute('aria-label')).toBe('Map');
    expect(entry(el, 'Map').querySelector('.count')).toBeNull();
    TestBed.resetTestingModule();
    const quiet = await nav('/home');
    expect(entry(quiet, 'Right Now').getAttribute('aria-label')).toBe('Right Now');
    expect(entry(quiet, 'Right Now').querySelector('.count')).toBeNull();
  });

  it('marks the entry of the screen shown as the current page', async () => {
    const cases: [url: string, name: string][] = [
      ['/home', 'Home'],
      ['/', 'Notes'],
      ['/n/n1', 'Notes'],
      ['/browse/recent?q=kiln', 'Notes'],
      ['/right-now', 'Right Now'],
      ['/kitchen/recipes', 'Kitchen'],
      ['/n/plan', 'Kitchen'],
      ['/n/groceries', 'Kitchen'],
      ['/reader/f/Design', 'Reader'],
      ['/podcasts/queue', 'Podcasts'],
      ['/map/n/n1', 'Map'],
      ['/activity', 'Assistants'],
      ['/settings', 'Settings'],
      // Settings as pages (#290): a page, and an old anchor, are Settings.
      ['/settings/modules', 'Settings'],
      ['/settings#downloads', 'Settings'],
    ];
    for (const [url, name] of cases) {
      const el = await nav(url, {
        kitchen: true,
        reader: true,
        listId: 'groceries',
        notes: [
          noteRecord('n1', 'Kiln day'),
          { ...noteRecord('plan', 'Week'), kind: 'mealplan', periodStart: '2026-11-16' },
          noteRecord('groceries', 'Groceries'),
        ],
      });
      expect([url, current(el)]).toEqual([url, [name]]);
      TestBed.resetTestingModule();
    }
    const share = await nav('/share');
    expect(current(share)).toEqual([]);
  });

  it('agrees with Home’s tiles: the same places, the same numbers', async () => {
    configure({ kitchen: true, reader: true });
    const home = TestBed.createComponent(Home);
    const rail = TestBed.createComponent(RailNav);
    rail.componentRef.setInput('url', '/home');
    await home.whenStable();
    await rail.whenStable();
    const homeEl = home.nativeElement as HTMLElement;
    const tiles = [...homeEl.querySelectorAll('nav a .name')].map((n) => n.textContent?.trim());
    const railEl = rail.nativeElement as HTMLElement;
    // The same places (the rail's order is its own: Map before Assistants).
    expect(
      names(railEl)
        .filter((n) => !['Home', 'Right Now', 'Settings'].includes(n!))
        .sort(),
    ).toEqual([...tiles].sort());
    const status = (name: string) =>
      [...homeEl.querySelectorAll('nav a')]
        .find((a) => a.querySelector('.name')?.textContent?.trim() === name)
        ?.querySelector('.status')?.textContent;
    const places = TestBed.inject(PlacesService);
    expect(status('Reader')).toBe(`${places.readerUnread()} unread`);
    expect(entry(railEl, 'Reader').querySelector('.count')?.textContent).toBe(
      String(places.readerUnread()),
    );
    expect(status('Podcasts')).toContain(`${places.podcastsNew()} new`);
    expect(entry(railEl, 'Podcasts').querySelector('.count')?.textContent).toBe(
      String(places.podcastsNew()),
    );
    expect(status('Reading queue')).toBe(`${places.toRead()} to read`);
    expect(status('Assistants')).toContain(`${places.suggestions()} suggestion`);
  });

  it('adds a module’s entry when it is switched on after the rail is drawn', async () => {
    const { modules } = configure();
    const fixture = TestBed.createComponent(RailNav);
    fixture.componentRef.setInput('url', '/home');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(names(el)).not.toContain('Kitchen');
    modules.set('kitchen', true);
    modules.set('reader', true);
    await fixture.whenStable();
    expect(names(el)).toEqual(expect.arrayContaining(['Kitchen', 'Reader', 'Podcasts']));
    modules.set('kitchen', false);
    await fixture.whenStable();
    expect(names(el)).not.toContain('Kitchen');
  });

  it('says a count after the name, nothing for none', () => {
    expect(placeLabel('Reader', { n: 179, counts: 'unread' })).toBe('Reader, 179 unread');
    expect(placeLabel('Reader', { n: 0, counts: 'unread' })).toBe('Reader');
    expect(placeLabel('Map')).toBe('Map');
  });
});

describe('where the rail is drawn (#289)', () => {
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    document.documentElement.classList.remove(RAIL_CLASS, RAIL_ICONS_CLASS);
  });

  async function shell(url: string, setup: Setup = {}) {
    configure(setup);
    const fixture = TestBed.createComponent(Rail);
    await TestBed.inject(Router).navigateByUrl(url);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('draws it, after a skip link, on the garden’s screens from 900 px', async () => {
    const el = await shell('/n/n1');
    const first = el.querySelector('a');
    expect(first?.textContent?.trim()).toBe('Skip to content');
    expect(el.querySelector('nav[aria-label="Places"]')).not.toBeNull();
    expect(document.documentElement.classList).toContain(RAIL_CLASS);
  });

  it('draws it while a device signed in before restores its session', async () => {
    const el = await shell('/', { signedIn: 'restoring' });
    expect(el.querySelector('nav')).not.toBeNull();
  });

  it('draws it as icons alone from 641 to 899 px, each named as before', async () => {
    for (const width of [641, 768, 899]) {
      const el = await shell('/home', { width, reader: true, due: ['Stamps'] });
      expect(el.querySelector('a')?.textContent?.trim()).toBe('Skip to content');
      const nav = el.querySelector('nav[aria-label="Places"]')!;
      expect([width, nav.classList.contains('icons')]).toEqual([width, true]);
      expect(document.documentElement.classList).toContain(RAIL_CLASS);
      // The same entries, their names kept for screen readers and a title.
      expect(names(el)).toEqual([
        'Home',
        'Notes',
        'Right Now',
        'Reader',
        'Podcasts',
        'Reading queue',
        'Map',
        'Assistants',
        'Settings',
      ]);
      const rightNow = entry(el, 'Right Now');
      expect(rightNow.getAttribute('aria-label')).toBe('Right Now, 1 due');
      expect(rightNow.getAttribute('title')).toBe('Right Now, 1 due');
      expect(rightNow.querySelector('.count')?.textContent).toBe('1');
      expect(entry(el, 'Map').getAttribute('title')).toBe('Map');
      expect(current(el)).toEqual(['Home']);
      TestBed.resetTestingModule();
    }
    // From 900 px the full rail: names shown, so no title.
    const wide = await shell('/home', { width: 900 });
    expect(wide.querySelector('nav')?.classList).not.toContain('icons');
    expect(entry(wide, 'Map').hasAttribute('title')).toBe(false);
  });

  it('draws nothing signed out, under 641 px, or on the sign-in pages', async () => {
    for (const [url, setup] of [
      ['/home', { signedIn: false }],
      ['/home', { width: 640 }],
      ['/home', { width: 412 }],
      ['/dev-sign-in', {}],
      ['/oauth/authorize?client_id=x', {}],
    ] as [string, Setup][]) {
      const el = await shell(url, setup);
      expect([url, el.querySelector('nav, a')]).toEqual([url, null]);
      expect(document.documentElement.classList).not.toContain(RAIL_CLASS);
      TestBed.resetTestingModule();
    }
  });

  it('is right from the first render, before the first navigation ends', async () => {
    // A cold load: the router still says `/`; the document says where.
    configure();
    TestBed.overrideProvider(OPENED_AT, { useValue: '/oauth/authorize?client_id=x' });
    let fixture = TestBed.createComponent(Rail);
    fixture.detectChanges();
    expect(TestBed.inject(Router).navigated).toBe(false);
    expect(fixture.nativeElement.querySelector('nav, a')).toBeNull();
    expect(document.documentElement.classList).not.toContain(RAIL_CLASS);
    TestBed.resetTestingModule();

    configure({ reader: true });
    TestBed.overrideProvider(OPENED_AT, { useValue: '/reader' });
    fixture = TestBed.createComponent(Rail);
    fixture.detectChanges();
    expect(TestBed.inject(Router).navigated).toBe(false);
    expect(current(fixture.nativeElement)).toEqual(['Reader']);
  });

  it('goes when the gardener signs out', async () => {
    const { auth } = configure();
    const fixture = TestBed.createComponent(Rail);
    await TestBed.inject(Router).navigateByUrl('/home');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('nav')).not.toBeNull();
    auth.user.set(null);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('nav')).toBeNull();
    expect(document.documentElement.classList).not.toContain(RAIL_CLASS);
  });
});

describe('currentPlace and offRail', () => {
  const plain = { kitchenNote: () => false, podcastsOn: true };

  it('puts Downloads under Podcasts while it is on, else the Reader', () => {
    expect(currentPlace('/reader/downloads', plain)).toBe('podcasts');
    expect(currentPlace('/reader/downloads', { ...plain, podcastsOn: false })).toBe('reader');
  });

  it('puts History under Notes, and an unknown path under nothing', () => {
    expect(currentPlace('/history?note=n1', plain)).toBe('notes');
    expect(currentPlace('/settings/assistants', plain)).toBe('settings');
    expect(currentPlace('/somewhere/new', plain)).toBeUndefined();
  });

  it('keeps off the development sign-in and Claude’s consent page only', () => {
    expect(offRail('/dev-sign-in')).toBe(true);
    expect(offRail('/oauth/authorize?x=1')).toBe(true);
    expect(offRail('/settings')).toBe(false);
    expect(offRail('/')).toBe(false);
  });
});

describe('the rail’s menu button (2026-11-22)', () => {
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    document.documentElement.classList.remove(RAIL_CLASS, RAIL_ICONS_CLASS);
  });

  /** The rail at `width`, with `stored` put on the device first. */
  async function shell(width: number, stored?: string) {
    configure({ width });
    if (stored !== undefined) localStorage.setItem(RAIL_KEY, stored);
    const fixture = TestBed.createComponent(Rail);
    await TestBed.inject(Router).navigateByUrl('/home');
    await fixture.whenStable();
    return fixture;
  }
  const menu = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('nav button.menu')!;
  const icons = (el: HTMLElement) => el.querySelector('nav')!.classList.contains('icons');
  const htmlIcons = () => document.documentElement.classList.contains(RAIL_ICONS_CLASS);

  it('comes first in the rail, after Skip to content, and controls the rail', async () => {
    const el = (await shell(1440)).nativeElement as HTMLElement;
    const nav = el.querySelector('nav')!;
    const focusable = [...el.querySelectorAll<HTMLElement>('a, button')];
    expect(focusable[0].textContent?.trim()).toBe('Skip to content');
    expect(focusable[1]).toBe(menu(el));
    expect(nav.firstElementChild).toBe(menu(el));
    expect(menu(el).getAttribute('type')).toBe('button');
    expect(menu(el).getAttribute('aria-controls')).toBe(nav.id);
    expect(nav.id).toBeTruthy();
    expect(menu(el).querySelector('app-icon')).not.toBeNull();
  });

  it('collapses the rail to icons and expands it again, saying which it will do', async () => {
    const fixture = await shell(1440);
    const el = fixture.nativeElement as HTMLElement;
    expect(icons(el)).toBe(false);
    expect(htmlIcons()).toBe(false);
    expect(menu(el).getAttribute('aria-label')).toBe('Collapse navigation');
    expect(menu(el).getAttribute('title')).toBe('Collapse navigation');
    expect(menu(el).getAttribute('aria-expanded')).toBe('true');

    menu(el).click();
    await fixture.whenStable();
    expect(icons(el)).toBe(true);
    expect(htmlIcons()).toBe(true);
    expect(document.documentElement.classList).toContain(RAIL_CLASS);
    expect(menu(el).getAttribute('aria-label')).toBe('Expand navigation');
    expect(menu(el).getAttribute('aria-expanded')).toBe('false');
    // The entries as the tablet's icons: named as before, with a title.
    expect(entry(el, 'Map').getAttribute('aria-label')).toBe('Map');
    expect(entry(el, 'Map').getAttribute('title')).toBe('Map');
    expect(current(el)).toEqual(['Home']);
    expect(localStorage.getItem(RAIL_KEY)).toBe('"icons"');

    menu(el).click();
    await fixture.whenStable();
    expect(icons(el)).toBe(false);
    expect(htmlIcons()).toBe(false);
    expect(menu(el).getAttribute('aria-label')).toBe('Collapse navigation');
    expect(menu(el).getAttribute('aria-expanded')).toBe('true');
    expect(entry(el, 'Map').hasAttribute('title')).toBe(false);
    expect(current(el)).toEqual(['Home']);
    expect(localStorage.getItem(RAIL_KEY)).toBe('"words"');
  });

  it('with nothing chosen, the width decides: icons under 900 px, names from it', async () => {
    for (const [width, expected] of [
      [641, true],
      [768, true],
      [899, true],
      [900, false],
      [1440, false],
    ] as [number, boolean][]) {
      const el = (await shell(width)).nativeElement as HTMLElement;
      expect([width, icons(el), htmlIcons()]).toEqual([width, expected, expected]);
      expect([width, menu(el).getAttribute('aria-expanded')]).toEqual([width, `${!expected}`]);
      TestBed.resetTestingModule();
    }
  });

  it('keeps one choice for every width once it is made', async () => {
    // Expanded on a tablet's width, then a fresh page there and wider.
    let fixture = await shell(768);
    menu(fixture.nativeElement).click();
    await fixture.whenStable();
    expect(icons(fixture.nativeElement)).toBe(false);
    expect(localStorage.getItem(RAIL_KEY)).toBe('"words"');
    for (const width of [641, 768, 1440]) {
      TestBed.resetTestingModule();
      fixture = await shell(width, '"words"');
      expect([width, icons(fixture.nativeElement)]).toEqual([width, false]);
    }
    // Contracted, at every width too.
    for (const width of [641, 900, 1440]) {
      TestBed.resetTestingModule();
      fixture = await shell(width, '"icons"');
      expect([width, icons(fixture.nativeElement), htmlIcons()]).toEqual([width, true, true]);
    }
  });

  it('reads anything else stored as no choice', async () => {
    for (const stored of ['"tiny"', '{not json', 'true']) {
      const el = (await shell(1440, stored)).nativeElement as HTMLElement;
      expect([stored, icons(el)]).toEqual([stored, false]);
      TestBed.resetTestingModule();
    }
  });

  it('works where storage throws, forgetting the choice', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    configure({ width: 1440 });
    TestBed.overrideProvider(STORAGE, { useValue: throwing });
    const fixture = TestBed.createComponent(Rail);
    await TestBed.inject(Router).navigateByUrl('/home');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(icons(el)).toBe(false);
    menu(el).click();
    await fixture.whenStable();
    expect(icons(el)).toBe(true);
    expect(menu(el).getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
  });

  it('is not drawn where the rail is not', async () => {
    const el = (await shell(640, '"words"')).nativeElement as HTMLElement;
    expect(el.querySelector('button, nav')).toBeNull();
    expect(htmlIcons()).toBe(false);
  });
});
