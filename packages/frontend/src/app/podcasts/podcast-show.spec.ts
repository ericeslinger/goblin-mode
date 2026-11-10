import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ModulesService } from '../modules/modules.service';
import { DownloadsService } from '../reader/downloads.service';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { PlayerService } from '../reader/player.service';
import { ReaderService } from '../reader/reader.service';
import { FakeDownloads, FakeItems, FakeModules, FakeReader } from '../testing/fakes';
import { PodcastShow } from './podcast-show';

const ep = (id: string, published: number, more: Partial<ItemRecord> = {}): ItemRecord => ({
  id,
  feedId: 'p1',
  title: `Episode ${id}`,
  link: '',
  published,
  summary: '',
  content: '',
  read: false,
  saved: false,
  enclosure: { url: 'https://pod.test/x.mp3', type: 'audio/mpeg', seconds: 2520 },
  ...more,
});

beforeAll(() => {
  // jsdom has no modal dialogs; the browser keeps focus inside and closes on Escape.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

async function open(url = '/podcasts/s/p1') {
  const reader = new FakeReader();
  reader.feeds.set([
    {
      id: 'p1',
      url: 'https://kiln.test/f',
      title: 'Kiln talk',
      folders: ['Making'],
      dead: false,
      kind: 'podcast',
      image: 'https://kiln.test/show.jpg',
    },
    {
      id: 'p2',
      url: 'https://dice.test/f',
      title: 'Dice and paper',
      folders: [],
      dead: false,
      kind: 'podcast',
    },
  ]);
  reader.podcastFolderNames.set(['Making']);
  const items = new FakeItems();
  items.episodes.set([
    ep('e3', 300, { title: 'Wood firing', summary: 'With the Leach kiln crew' }),
    ep('e2', 200, { title: 'Ash glazes', position: 600, read: true }),
    ep('e1', 100, { title: 'Shelf wash', played: true }),
    { ...ep('x1', 250), feedId: 'p2' },
  ]);
  const player = {
    current: signal<string | undefined>(undefined),
    playing: signal(false),
    position: signal(0),
    duration: signal(0),
    load: vi.fn(),
    toggle: vi.fn(),
  };
  const modules = new FakeModules();
  modules.set('podcasts', true);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'podcasts/s/:feedId', component: PodcastShow }]),
      { provide: ItemsService, useValue: items },
      { provide: ReaderService, useValue: reader },
      { provide: PlayerService, useValue: player },
      { provide: DownloadsService, useValue: new FakeDownloads() },
      { provide: ModulesService, useValue: modules },
    ],
  });
  const harness = await RouterTestingHarness.create(url);
  const el = harness.routeNativeElement!;
  const rows = () =>
    [...el.querySelectorAll('ul[aria-label="Episodes"] > li')].map((li) =>
      [li.querySelector('.title'), li.querySelector('.meta')]
        .map((n) => n!.textContent!.replace(/\s+/g, ' ').trim())
        .join(' '),
    );
  const titles = () =>
    rows().map((r) => r.split(' New')[0].split(' Started')[0].split(' Heard')[0]);
  const button = (name: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent!.replace(/\s+/g, ' ').trim()) === name,
    );
  const stable = () => harness.fixture.whenStable();
  return { harness, el, rows, titles, button, stable, items, reader, player };
}

describe('A show’s page (#246)', () => {
  it('has its artwork, its name, its counts, its folder and its switches', async () => {
    const { el } = await open();
    expect(el.querySelector('h1')?.textContent).toBe('Kiln talk');
    expect(el.querySelector('.head img')?.getAttribute('src')).toBe('https://kiln.test/show.jpg');
    expect(el.querySelector('.head img')?.getAttribute('alt')).toBe('');
    const meta = [...el.querySelectorAll('.head .meta')].map((p) => p.textContent!.trim());
    expect(meta).toEqual(['3 episodes · 2 unheard', 'In Making']);
    expect(el.querySelector('input[role="switch"]')?.closest('label')?.textContent).toContain(
      'New episodes join the queue',
    );
    expect(
      el.querySelector('select[aria-label="Episodes of Kiln talk kept downloaded"]'),
    ).not.toBeNull();
    expect(el.querySelector('a.back')?.getAttribute('href')).toBe('/podcasts/shows');
  });

  it('writes the queue switch through the reader', async () => {
    const { el, reader, stable } = await open();
    const sw = el.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(sw.checked).toBe(false);
    sw.click();
    await stable();
    expect(reader.setAutoQueue).toHaveBeenCalledWith('p1', true);
    expect(sw.checked).toBe(true);
    expect(el.textContent).toContain('On: its new episodes go to the end of the queue');
    // The queue is here now (#249): no note that it comes soon.
    expect(el.textContent).not.toContain('comes soon');
  });

  it('adds an episode to the queue from its row (#249)', async () => {
    const { button, items, stable } = await open();
    button('Add Wood firing to the queue')!.click();
    await stable();
    expect(items.addToQueue).toHaveBeenCalledWith('e3');
    expect(button('Wood firing is in the queue')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('filters Unheard and All, with counts, and sorts oldest first', async () => {
    const { rows, titles, button, stable, el } = await open();
    expect(button('Unheard 2')?.getAttribute('aria-pressed')).toBe('true');
    expect(rows()).toEqual([
      'Wood firing New · just now · 42 min',
      'Ash glazes Started, notes read · just now · 32 min left',
    ]);
    // Rows as in Latest, without the artwork; opening one keeps the way back.
    expect(el.querySelector('ul[aria-label="Episodes"] img')).toBeNull();
    expect(el.querySelector('ul[aria-label="Episodes"] a')?.getAttribute('href')).toBe(
      '/podcasts/e/e3?show=p1',
    );
    button('All 3')!.click();
    await stable();
    expect(titles()).toEqual(['Wood firing', 'Ash glazes', 'Shelf wash']);
    button('Newest first')!.click();
    await stable();
    expect(button('Oldest first')).toBeTruthy();
    expect(titles()).toEqual(['Shelf wash', 'Ash glazes', 'Wood firing']);
  });

  it('searches the loaded episodes by title and notes', async () => {
    const { el, titles, button, stable } = await open();
    button('Search this show')!.click();
    await stable();
    const field = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(field.getAttribute('aria-label')).toBe('Search Kiln talk');
    expect(el.textContent).toContain('Searches the 3 episodes loaded here, by title and notes.');
    field.value = 'leach crew';
    field.dispatchEvent(new Event('input'));
    await stable();
    expect(titles()).toEqual(['Wood firing']);
    field.value = 'nothing like it';
    field.dispatchEvent(new Event('input'));
    await stable();
    expect(titles()).toEqual([]);
    expect(el.textContent).toContain('No episode loaded here holds those words.');
    // Closed, every episode again.
    button('Search this show')!.click();
    await stable();
    expect(titles()).toEqual(['Wood firing', 'Ash glazes']);
  });

  it('marks all its unheard loaded episodes heard from More, in one batch', async () => {
    const { el, button, stable, items } = await open();
    button('More for Kiln talk')!.click();
    await stable();
    const dialog = el.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-label')).toBe('More for Kiln talk');
    expect(
      [...dialog.querySelectorAll('button')].map((b) => b.textContent!.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      'Move to a folder',
      'Move to the Reader For a feed that is mostly writing',
      'Mark all as heard',
      'Unfollow',
      'Close',
    ]);
    button('Mark all as heard')!.click();
    await stable();
    expect(items.setPlayedMany).toHaveBeenCalledWith(['e3', 'e2']);
    expect(dialog.open).toBe(false);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Marked 2 episodes heard.');
  });

  it('says what Mark all as heard leaves when older episodes are not loaded', async () => {
    const { el, button, stable, items } = await open();
    items.more.set({ p1: true });
    await stable();
    button('More for Kiln talk')!.click();
    button('Mark all as heard')!.click();
    await stable();
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'Older episodes not loaded here are left as they were.',
    );
  });

  it('shows older episodes on demand, after the newest', async () => {
    const { el, titles, button, stable, items } = await open();
    expect(button('Show older episodes')).toBeUndefined();
    items.more.set({ p1: true });
    await stable();
    expect(el.querySelector('.head .meta')?.textContent).toContain('3+ episodes');
    items.loadOlder.mockImplementation(async () => {
      items.older.set({ p1: [ep('old', 10, { title: 'Cone packs' })] });
      items.more.set({ p1: false });
      return 1;
    });
    button('Show older episodes')!.click();
    await stable();
    expect(items.loadOlder).toHaveBeenCalledWith('p1');
    expect(titles()).toEqual(['Wood firing', 'Ash glazes', 'Cone packs']);
    expect(button('Show older episodes')).toBeUndefined();
    expect(el.querySelector('.head .meta')?.textContent).toContain('4 episodes · 3 unheard');
  });

  it('moves the show to a folder, or to the Reader', async () => {
    const { el, button, stable, reader, items } = await open();
    button('More for Kiln talk')!.click();
    await stable();
    button('Move to a folder')!.click();
    await stable();
    const field = el.querySelector<HTMLInputElement>('dialog input[list="show-folders"]')!;
    expect(field.value).toBe('Making');
    field.value = 'Kitchen';
    button('Move')!.click();
    await stable();
    expect(reader.setFolders).toHaveBeenCalledWith('p1', ['Kitchen']);
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'Kiln talk is in Kitchen now.',
    );
    expect(el.querySelectorAll('.head .meta')[1].textContent).toContain('In Kitchen');
    items.moved = (id) => reader.setPodcast(id, false);
    button('More for Kiln talk')!.click();
    await stable();
    button('Move to the Reader For a feed that is mostly writing')!.click();
    await stable();
    expect(items.moveToReader).toHaveBeenCalledWith('p1');
    expect(reader.setPodcast).toHaveBeenCalledWith('p1', false);
    expect(el.querySelector('h1')).toBeNull();
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'Kiln talk is in the Reader now.',
    );
  });

  it('takes a show’s queued episodes off the queue as it moves to the Reader (#251)', async () => {
    const { el, button, stable, items, reader } = await open();
    items.moved = (id) => reader.setPodcast(id, false);
    items.episodes.update((l) =>
      l.map((e) =>
        e.id === 'e3' ? { ...e, queue: 1000 } : e.id === 'e2' ? { ...e, queue: 2000 } : e,
      ),
    );
    await stable();
    button('More for Kiln talk')!.click();
    await stable();
    button('Move to the Reader For a feed that is mostly writing')!.click();
    await stable();
    expect(items.queue()).toEqual([]);
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'Kiln talk is in the Reader now. 2 episodes left the queue.',
    );
  });

  it('asks before unfollowing', async () => {
    const { el, button, stable, reader } = await open();
    button('More for Kiln talk')!.click();
    await stable();
    button('Unfollow')!.click();
    await stable();
    expect(reader.removeFeed).not.toHaveBeenCalled();
    expect(el.querySelector('dialog')?.textContent).toContain('Unfollow Kiln talk?');
    button('Keep following')!.click();
    await stable();
    button('Unfollow')!.click();
    await stable();
    button('Unfollow Kiln talk')!.click();
    await stable();
    expect(reader.removeFeed).toHaveBeenCalledWith('p1');
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Unfollowed Kiln talk.');
  });

  it('says when the show is not followed here', async () => {
    const { el } = await open('/podcasts/s/nope');
    expect(el.textContent).toContain('That show is not followed here.');
  });
});
