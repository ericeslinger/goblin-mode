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
import { PodcastsLatest } from './podcasts-latest';

const audio = (seconds: number) => ({ url: 'https://pod.test/x.mp3', type: 'audio/mpeg', seconds });
const ep = (id: string, feedId: string, more: Partial<ItemRecord> = {}): ItemRecord => ({
  id,
  feedId,
  title: `Episode ${id}`,
  link: '',
  published: 0,
  summary: '',
  content: '',
  read: false,
  saved: false,
  enclosure: audio(2520),
  ...more,
});

async function open(url = '/podcasts') {
  const items = new FakeItems();
  items.episodes.set([
    ep('e1', 'p1'),
    ep('e2', 'p2', { read: true, image: 'https://pod.test/2.jpg' }),
    ep('e3', 'p1', { position: 1200 }),
    ep('e4', 'p2', { played: true, read: true }),
  ]);
  const reader = new FakeReader();
  reader.feeds.set([
    {
      id: 'p1',
      url: 'https://kiln.test/f',
      title: 'Kiln talk',
      folders: [],
      dead: false,
      kind: 'podcast',
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
      provideRouter([{ path: 'podcasts', component: PodcastsLatest }]),
      { provide: ItemsService, useValue: items },
      { provide: ReaderService, useValue: reader },
      { provide: PlayerService, useValue: player },
      { provide: DownloadsService, useValue: new FakeDownloads() },
      { provide: ModulesService, useValue: modules },
    ],
  });
  const harness = await RouterTestingHarness.create(url);
  const el = harness.routeNativeElement!;
  /** Each row's title, then its line, as a screen reader reads them. */
  const rows = () =>
    [...el.querySelectorAll('ul[aria-label="Episodes"] > li')].map((li) =>
      [li.querySelector('.title'), li.querySelector('.meta')]
        .map((n) => n!.textContent!.replace(/\s+/g, ' ').trim())
        .join(' '),
    );
  const button = (name: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent!.replace(/\s+/g, ' ').trim()) === name,
    );
  return { harness, el, rows, button, player, items };
}

describe('Latest (#245)', () => {
  it('lists the new episodes, notes read still new, with their show, age and length', async () => {
    const { el, rows } = await open();
    expect(rows()).toEqual([
      'Episode e1 New · Kiln talk · just now · 42 min',
      'Episode e2 New, notes read · Dice and paper · just now · 42 min',
    ]);
    // The episode's artwork, else its show's initials on a tinted square.
    expect(el.querySelector('ul img')?.getAttribute('src')).toBe('https://pod.test/2.jpg');
    expect(el.querySelector('ul .square')?.textContent?.trim()).toBe('KT');
    const tabs = el.querySelector('nav[aria-label="Podcasts screens"]')!;
    // The Queue tab (#249), with how many are in it.
    expect(
      [...tabs.querySelectorAll('a')].map((a) => a.textContent!.replace(/\s+/g, ' ').trim()),
    ).toEqual(['Latest 2 new', 'Shows', 'Queue 0 in the queue']);
    expect(tabs.querySelector('a[aria-current="page"]')?.textContent).toContain('Latest');
    expect(el.querySelector('a[aria-label="Add a podcast"]')?.getAttribute('href')).toBe(
      '/podcasts/add',
    );
    expect(el.querySelector('a[aria-label="Downloads"]')).not.toBeNull();
  });

  it('filters New, Started and All, with counts', async () => {
    const { harness, rows, button } = await open();
    expect(button('New 2')?.getAttribute('aria-pressed')).toBe('true');
    button('Started 1')!.click();
    await harness.fixture.whenStable();
    expect(button('Started 1')?.getAttribute('aria-pressed')).toBe('true');
    expect(rows()).toEqual(['Episode e3 Started · Kiln talk · just now · 22 min left']);
    button('All')!.click();
    await harness.fixture.whenStable();
    expect(rows().map((r) => r.split(' · ')[0])).toEqual([
      'Episode e1 New',
      'Episode e2 New, notes read',
      'Episode e3 Started',
      'Episode e4 Heard',
    ]);
  });

  it('plays with the app’s player; the one playing has Pause and the time left', async () => {
    const { harness, rows, button, player } = await open();
    button('Play Episode e1')!.click();
    expect(player.load).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), {
      autoplay: true,
    });
    player.current.set('e1');
    player.playing.set(true);
    player.position.set(600);
    player.duration.set(2520);
    await harness.fixture.whenStable();
    expect(button('Pause Episode e1')).toBeTruthy();
    expect(rows()[0]).toContain('32 min left');
    button('Pause Episode e1')!.click();
    expect(player.toggle).toHaveBeenCalled();
  });

  it('draws an episode with no artwork of its own with its show’s, the square when it fails (#246)', async () => {
    const { harness, el } = await open();
    const reader = TestBed.inject(ReaderService) as unknown as FakeReader;
    reader.feeds.update((l) =>
      l.map((f) => (f.id === 'p1' ? { ...f, image: 'https://kiln.test/show.jpg' } : f)),
    );
    await harness.fixture.whenStable();
    const first = el.querySelector('ul[aria-label="Episodes"] > li')!;
    expect(first.querySelector('img')?.getAttribute('src')).toBe('https://kiln.test/show.jpg');
    first.querySelector('img')!.dispatchEvent(new Event('error'));
    await harness.fixture.whenStable();
    expect(first.querySelector('img')).toBeNull();
    expect(first.querySelector('.square')?.textContent?.trim()).toBe('KT');
  });

  it('adds an episode to the queue from its row, pressed once in it, off again (#249)', async () => {
    const { harness, button, items, el } = await open();
    const add = button('Add Episode e1 to the queue')!;
    expect(add.getAttribute('aria-pressed')).toBe('false');
    add.click();
    await harness.fixture.whenStable();
    expect(items.addToQueue).toHaveBeenCalledWith('e1');
    const queued = button('Episode e1 is in the queue')!;
    expect(queued.getAttribute('aria-pressed')).toBe('true');
    const tabs = el.querySelector('nav[aria-label="Podcasts screens"]')!;
    expect(tabs.textContent!.replace(/\s+/g, ' ')).toContain('Queue 1 in the queue');
    queued.click();
    await harness.fixture.whenStable();
    expect(items.removeFromQueue).toHaveBeenCalledWith('e1');
    expect(button('Add Episode e1 to the queue')?.getAttribute('aria-pressed')).toBe('false');
  });
});
