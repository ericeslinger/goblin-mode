import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { ACTIVITY_API } from '../claude/activity';
import { ProposalsService } from '../claude/proposals.service';
import { FIREBASE } from '../firebase';
import { GroceryService } from '../kitchen/grocery.service';
import { ModulesService } from '../modules/modules.service';
import { type NoteRecord, NotesService } from '../notes/notes.service';
import { NOW } from '../platform/platform';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { PlayerService } from '../reader/player.service';
import { type FeedRecord, ReaderService } from '../reader/reader.service';
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
import { Home } from './home';
import { type Arrangement, HOME_TILES_KEY, HomeTilesService } from './home-tiles';

// Tuesday 2026-11-10, 6 pm, local time.
const NOW_MS = new Date(2026, 10, 10, 18).getTime();

interface Setup {
  notes?: NoteRecord[];
  kitchen?: boolean;
  reader?: boolean;
  /** The reminders overdue or due today, as the service's `due` has them. */
  reminders?: string[];
  listId?: string;
  runs?: number[];
  arrangement?: Arrangement;
  /** The Podcasts tile (#251): the episodes at hand, the shows, and what plays. */
  episodes?: ItemRecord[];
  shows?: FeedRecord[];
  playing?: { item: ItemRecord; position: number; duration: number };
}

async function render(setup: Setup = {}) {
  localStorage.clear();
  if (setup.arrangement) localStorage.setItem(HOME_TILES_KEY, JSON.stringify(setup.arrangement));
  const auth = new FakeAuthService();
  auth.user.set({ uid: 'u1', email: 'eric@example.com' } as User);
  const notes = new FakeNotes();
  notes.signIn(setup.notes ?? []);
  const modules = new FakeModules();
  if (setup.kitchen) modules.set('kitchen', true);
  if (setup.reader) modules.set('reader', true);
  const items = new FakeItems();
  items.unreadCounts.set({ all: 14, saved: 0 });
  const ep = (id: string, more: Partial<ItemRecord> = {}): ItemRecord => ({
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
  items.episodes.set(
    setup.episodes ?? [
      ep('e1'),
      ep('e2', { read: true }),
      ep('e3', { position: 120 }),
      ep('e4', { played: true, read: true }),
    ],
  );
  const reader = new FakeReader();
  reader.feeds.set(
    setup.shows ?? [
      {
        id: 'p1',
        url: 'https://p.test/f',
        title: 'Kiln talk',
        folders: [],
        dead: false,
        kind: 'podcast',
      },
    ],
  );
  const player = {
    item: signal(setup.playing?.item),
    playing: signal(!!setup.playing),
    position: signal(setup.playing?.position ?? 0),
    duration: signal(setup.playing?.duration ?? 0),
  };
  items.newSince.set([
    { folder: 'Design', count: 3 },
    { folder: 'Clay', count: 2 },
  ]);
  const proposals = new FakeProposals();
  const activity = {
    listen: vi.fn(
      (_db, _path, next: (docs: { id: string; data: Record<string, unknown> }[]) => void) => {
        next(
          (setup.runs ?? []).map((at, i) => ({
            id: `r${i}`,
            data: { at: { toMillis: () => at } },
          })),
        );
        return () => undefined;
      },
    ),
  };
  await TestBed.configureTestingModule({
    imports: [Home],
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: auth },
      { provide: NotesService, useValue: notes },
      { provide: ModulesService, useValue: modules },
      { provide: ItemsService, useValue: items },
      { provide: ReaderService, useValue: reader },
      { provide: PlayerService, useValue: player },
      { provide: ProposalsService, useValue: proposals },
      { provide: ReadingService, useValue: { unread: signal([{}, {}, {}]) } },
      {
        provide: RemindersService,
        useValue: {
          due: signal((setup.reminders ?? []).map((text, i) => ({ id: `${i}`, text }))),
        },
      },
      { provide: GroceryService, useValue: { listId: signal(setup.listId) } },
      { provide: ACTIVITY_API, useValue: activity },
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: NOW, useValue: () => NOW_MS },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Home);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

/** Arrange Home, opened from its button. */
async function arranging(setup: Setup = {}) {
  const el = await render(setup);
  el.querySelector<HTMLButtonElement>('button.arrange')!.click();
  await TestBed.inject(ApplicationRef).whenStable();
  return el;
}

const settle = () => TestBed.inject(ApplicationRef).whenStable();
const listed = (el: HTMLElement) =>
  [...el.querySelectorAll('ul[aria-label="Tiles, drag to reorder"] > li.tile .name')].map((n) =>
    n.textContent?.trim(),
  );
const press = async (el: HTMLElement, name: string, key: string) => {
  el.querySelector<HTMLButtonElement>(`button[aria-label="Move ${name}"]`)!.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
  await settle();
};

const tile = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLAnchorElement>('nav a')].find(
    (a) => a.querySelector('.name')?.textContent?.trim() === name,
  );
const names = (el: HTMLElement) =>
  [...el.querySelectorAll('nav a .name')].map((n) => n.textContent?.trim());

describe('Home (#219)', () => {
  it('shows a tile for each place, in order, none for a module that is off', async () => {
    const el = await render();
    expect(names(el)).toEqual(['Notes', 'Reading queue', 'Assistants', 'Map']);
    expect(tile(el, 'Notes')?.getAttribute('href')).toBe('/browse');
    expect(tile(el, 'Map')?.getAttribute('href')).toBe('/map');
  });

  it('shows Kitchen, the Reader and Podcasts once they are on', async () => {
    const el = await render({ kitchen: true, reader: true });
    // Podcasts follows the Reader until switched itself (#245).
    expect(names(el)).toEqual([
      'Notes',
      'Kitchen',
      'Reader',
      'Podcasts',
      'Reading queue',
      'Assistants',
      'Map',
    ]);
    expect(tile(el, 'Kitchen')?.getAttribute('href')).toBe('/kitchen');
    // The Reader counts its articles only; the episodes are Podcasts' (#245).
    expect(tile(el, 'Reader')?.textContent?.trim()).toMatch(/14 unread$/);
    expect(tile(el, 'Podcasts')?.getAttribute('href')).toBe('/podcasts');
    // New until heard: notes read is still new (#251: and the queue, not Started).
    expect(tile(el, 'Podcasts')?.textContent?.trim()).toMatch(/Podcasts\s*2 new$/);
  });

  describe('the Podcasts tile’s line (#251)', () => {
    const ep = (id: string, more: Partial<ItemRecord> = {}): ItemRecord => ({
      id,
      feedId: 'p1',
      title: id,
      link: '',
      published: 0,
      summary: '',
      content: '',
      read: false,
      saved: false,
      enclosure: { url: 'https://p.test/a.mp3', type: 'audio/mpeg', seconds: 2520 },
      ...more,
    });
    const line = async (setup: Setup) =>
      tile(await render({ reader: true, ...setup }), 'Podcasts')
        ?.querySelector('.status')
        ?.textContent?.trim();

    it('says what is new and what is in the queue, leaving out a zero part', async () => {
      expect(
        await line({
          episodes: [ep('a'), ep('b', { queue: 1 }), ep('c', { played: true, queue: 2 })],
        }),
      ).toBe('2 new · 2 in the queue');
    });

    it('leaves out the new part when nothing is new', async () => {
      expect(await line({ episodes: [ep('a', { played: true, queue: 1 })] })).toBe(
        '1 in the queue',
      );
    });

    it('says what is playing with its time left', async () => {
      const playing = ep('Reduction firing', { position: 600 });
      expect(
        await line({
          episodes: [playing, ep('b')],
          playing: { item: playing, position: 1200, duration: 2520 },
        }),
      ).toBe('Playing: Reduction firing · 22 min left');
    });

    it('counts the shows when nothing is new or queued, else says what it is', async () => {
      expect(await line({ episodes: [ep('a', { played: true })] })).toBe('1 show');
    });

    it('says what the module is with no shows', async () => {
      expect(await line({ episodes: [], shows: [] })).toBe('Shows and the queue');
    });
  });

  it('counts the live notes and those written in today', async () => {
    const today = NOW_MS - 60 * 60 * 1000;
    const yesterday = NOW_MS - 30 * 60 * 60 * 1000;
    const el = await render({
      notes: [
        { ...noteRecord('a', 'Kiln shelf'), updatedAt: today },
        { ...noteRecord('b', 'Glaze notes'), updatedAt: yesterday },
        { ...noteRecord('c', 'Old'), archived: true, updatedAt: today },
        { ...noteRecord('t', 'A template'), kind: 'template', updatedAt: today },
      ],
    });
    expect(tile(el, 'Notes')?.textContent).toContain('2 · 1 today');
  });

  it('names tonight’s dinner from this week’s plan and what is left to buy', async () => {
    const el = await render({
      kitchen: true,
      listId: 'groceries',
      notes: [
        {
          ...noteRecord(
            'meals-2026-11-09',
            '- [ ] Mon dinner: out\n- [ ] Tue dinner: [[Shakshuka]]\n',
          ),
          kind: 'mealplan',
          periodStart: '2026-11-09',
        },
        noteRecord('groceries', '## Shopping\n\n- [ ] eggs\n- [x] feta\n- [ ] peppers\n'),
      ],
    });
    expect(tile(el, 'Kitchen')?.textContent).toContain('Tonight: Shakshuka · 2 to buy');
  });

  it('says when nothing is planned tonight', async () => {
    const el = await render({ kitchen: true });
    expect(tile(el, 'Kitchen')?.textContent).toContain('Tonight: nothing planned');
  });

  it('shows the reminders due today and what is new in the Reader, linking to Right Now', async () => {
    const el = await render({
      reader: true,
      reminders: ['Glaze the mugs', 'Plan the week', 'Call'],
    });
    const row = el.querySelector<HTMLAnchorElement>('a.right-now')!;
    expect(row.getAttribute('href')).toBe('/right-now');
    expect(row.textContent).toContain('Glaze the mugs · Plan the week · 5 new in the Reader');
    // And Podcasts' line beside it (#251), the Latest never seen on this device.
    expect(row.textContent).toContain('5 new in the Reader · 2 new in Podcasts');
    expect(row.textContent).not.toContain('Call');
  });

  it('leaves the Reader out of Right Now while it is off', async () => {
    const el = await render();
    expect(el.querySelector('a.right-now')?.textContent).toContain('Nothing to tend');
  });

  it('counts suggestions and today’s runs for Assistants', async () => {
    const el = await render({ runs: [NOW_MS - 1000, NOW_MS - 2000, NOW_MS - 48 * 3600 * 1000] });
    expect(tile(el, 'Assistants')?.textContent).toContain('0 suggestions · 2 runs today');
    expect(tile(el, 'Reading queue')?.textContent).toContain('3 to read');
  });

  it('opens the editor from its box, a link that holds no typing', async () => {
    const el = await render();
    const box = el.querySelector<HTMLAnchorElement>('a.write')!;
    expect(box.getAttribute('href')).toBe('/');
    expect(box.textContent).toContain('Plant a thought');
    expect(el.querySelector('input, textarea, [contenteditable]')).toBeNull();
    expect(el.querySelector('a[aria-label="Settings"]')?.getAttribute('href')).toBe('/settings');
  });
});

describe('Arrange Home (#222)', () => {
  afterEach(() => localStorage.clear());

  it('shows the tiles in the gardener’s order', async () => {
    const el = await render({
      kitchen: true,
      arrangement: { order: ['map', 'kitchen', 'notes', 'reading', 'assistants'], hidden: [] },
    });
    expect(names(el)).toEqual(['Map', 'Kitchen', 'Notes', 'Reading queue', 'Assistants']);
  });

  it('hides a module that is off, whatever the order says', async () => {
    const el = await render({
      arrangement: { order: ['reader', 'map', 'kitchen', 'notes'], hidden: [] },
    });
    expect(names(el)).toEqual(['Map', 'Notes', 'Reading queue', 'Assistants']);
  });

  it('puts a tile missing from the order at the end, in the default order', async () => {
    const el = await render({
      kitchen: true,
      reader: true,
      arrangement: { order: ['assistants', 'notes', 'unknown'], hidden: ['map'] },
    });
    expect(names(el)).toEqual([
      'Assistants',
      'Notes',
      'Kitchen',
      'Reader',
      'Podcasts',
      'Reading queue',
    ]);
  });

  it('opens from its button, with a grip per tile, and Done goes back', async () => {
    const el = await arranging();
    expect(el.querySelector('h1')?.textContent).toContain('Arrange Home');
    expect(listed(el)).toEqual(['Notes', 'Reading queue', 'Assistants', 'Map']);
    expect(el.querySelector('button[aria-label="Move Notes"]')).not.toBeNull();
    expect(document.activeElement?.textContent?.trim()).toBe('Done');
    el.querySelector<HTMLButtonElement>('button.done')!.click();
    await settle();
    expect(names(el)).toEqual(['Notes', 'Reading queue', 'Assistants', 'Map']);
  });

  it('opens on a tile held for 400 ms, still', async () => {
    const el = await render();
    vi.useFakeTimers();
    try {
      const link = tile(el, 'Map')!;
      // A pointer event as the browser gives it (jsdom has no PointerEvent).
      link.dispatchEvent(
        Object.assign(new MouseEvent('pointerdown', { button: 0, bubbles: true }), {
          isPrimary: true,
        }),
      );
      vi.advanceTimersByTime(399);
      expect(el.querySelector('button.done')).toBeNull();
      vi.advanceTimersByTime(1);
      TestBed.tick();
      expect(el.querySelector('button.done')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves a tile by its grip’s arrows, a slot across or a row, and says where', async () => {
    const el = await arranging({ kitchen: true });
    // Notes, Kitchen / Reading queue, Assistants / Map
    await press(el, 'Kitchen', 'ArrowLeft');
    expect(listed(el)).toEqual(['Kitchen', 'Notes', 'Reading queue', 'Assistants', 'Map']);
    await press(el, 'Kitchen', 'ArrowRight');
    expect(listed(el)).toEqual(['Notes', 'Kitchen', 'Reading queue', 'Assistants', 'Map']);
    await press(el, 'Kitchen', 'ArrowDown');
    expect(listed(el)).toEqual(['Notes', 'Reading queue', 'Assistants', 'Kitchen', 'Map']);
    expect(el.querySelector('[aria-live="polite"]')?.textContent).toContain('Kitchen, 4 of 5');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move Kitchen');
    await press(el, 'Map', 'ArrowUp');
    expect(listed(el)).toEqual(['Notes', 'Reading queue', 'Map', 'Assistants', 'Kitchen']);
    // Past the end, it stays.
    await press(el, 'Notes', 'ArrowUp');
    expect(listed(el)[0]).toBe('Notes');
    expect(TestBed.inject(HomeTilesService).arrangement().order).toEqual([
      'notes',
      'reading',
      'map',
      'assistants',
      'kitchen',
    ]);
  });

  it('takes a tile off Home and puts it back at the end, through Not on Home', async () => {
    const el = await arranging();
    expect(el.textContent).toContain('Every tile is on Home.');
    el.querySelector<HTMLButtonElement>('button[aria-label="Remove Notes"]')!.click();
    await settle();
    expect(listed(el)).toEqual(['Reading queue', 'Assistants', 'Map']);
    const off = el.querySelector('section[aria-labelledby="not-on-home"]')!;
    expect(off.textContent).toContain('Notes');
    off.querySelector<HTMLButtonElement>('button[aria-label="Add Notes"]')!.click();
    await settle();
    expect(listed(el)).toEqual(['Reading queue', 'Assistants', 'Map', 'Notes']);
    expect(TestBed.inject(HomeTilesService).arrangement().hidden).toEqual([]);
  });

  it('keeps a hidden tile off Home after Done', async () => {
    const el = await arranging();
    el.querySelector<HTMLButtonElement>('button[aria-label="Remove Map"]')!.click();
    await settle();
    el.querySelector<HTMLButtonElement>('button.done')!.click();
    await settle();
    expect(names(el)).toEqual(['Notes', 'Reading queue', 'Assistants']);
    expect(JSON.parse(localStorage.getItem(HOME_TILES_KEY)!)).toMatchObject({ hidden: ['map'] });
  });
});
