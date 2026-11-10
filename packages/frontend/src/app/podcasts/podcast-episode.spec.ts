import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { DownloadsService } from '../reader/downloads.service';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { PlayerService } from '../reader/player.service';
import { ReaderService } from '../reader/reader.service';
import { FakeDownloads, FakeItems, FakeReader } from '../testing/fakes';
import { PodcastEpisode } from './podcast-episode';

const episode: ItemRecord = {
  id: 'e1',
  feedId: 'p1',
  title: 'Reduction firing',
  link: '',
  published: 0,
  summary: '',
  content: 'Why the flame goes orange.',
  read: true,
  saved: false,
  enclosure: { url: 'https://pod.test/1.mp3', type: 'audio/mpeg', seconds: 2530 },
};

async function open() {
  const items = new FakeItems();
  items.episodes.set([episode, { ...episode, id: 'e2', title: 'Wedging clay', queue: 5 }]);
  Object.assign(items, {
    find: (id: string) => items.episodes().find((e) => e.id === id),
    clock: (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
  });
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
  ]);
  const player = {
    current: signal<string | undefined>(undefined),
    playing: signal(false),
    position: signal(0),
    duration: signal(0),
    rate: signal(1),
    offer: signal<number | undefined>(undefined),
    load: vi.fn(),
    toggle: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'podcasts/e/:id', component: PodcastEpisode }]),
      { provide: ItemsService, useValue: items },
      { provide: ReaderService, useValue: reader },
      { provide: PlayerService, useValue: player },
      { provide: DownloadsService, useValue: new FakeDownloads() },
    ],
  });
  const harness = await RouterTestingHarness.create('/podcasts/e/e1');
  const el = harness.routeNativeElement!;
  const button = (name: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent!.replace(/\s+/g, ' ').trim()) === name,
    );
  return { harness, el, items, button };
}

describe('An episode’s page and the queue (#249)', () => {
  it('adds it to the queue, In the queue once there, and off again', async () => {
    const { harness, items, button, el } = await open();
    const add = button('Add to the queue')!;
    expect(add.getAttribute('aria-pressed')).toBe('false');
    add.click();
    await harness.fixture.whenStable();
    expect(items.addToQueue).toHaveBeenCalledWith('e1');
    expect(button('In the queue')?.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Added to the end');
    button('In the queue')!.click();
    await harness.fixture.whenStable();
    expect(items.removeFromQueue).toHaveBeenCalledWith('e1');
    expect(button('Add to the queue')).toBeTruthy();
  });

  it('plays it next: first in the queue', async () => {
    const { harness, items, button } = await open();
    button('Play next')!.click();
    await harness.fixture.whenStable();
    expect(items.playNext).toHaveBeenCalledWith('e1');
    expect(items.queue().map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(button('In the queue')).toBeTruthy();
  });
});
