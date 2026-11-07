import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { FakeReader } from '../testing/fakes';
import type { ItemRecord } from './items.service';
import { ItemsService } from './items.service';
import { MiniPlayer } from './mini-player';
import { PlayerService } from './player.service';
import { ReaderService } from './reader.service';

@Component({ template: '' })
class Blank {}

const episode: ItemRecord = {
  id: 'e1',
  feedId: 'pod',
  title: 'Reduction firing',
  link: '',
  published: 0,
  summary: '',
  content: '',
  read: false,
  saved: false,
  enclosure: { url: 'https://pod.test/e1.mp3', type: 'audio/mpeg', seconds: 2530 },
};

function setup() {
  const player = {
    item: signal<ItemRecord | undefined>(undefined),
    playing: signal(false),
    position: signal(754),
    duration: signal(2530),
    offer: signal<number | undefined>(undefined),
    toggle: vi.fn(),
    skip: vi.fn(),
    stop: vi.fn(),
    takeOffer: vi.fn(),
  };
  TestBed.configureTestingModule({
    imports: [MiniPlayer],
    providers: [
      provideRouter([
        { path: 'reader', component: Blank },
        { path: 'reader/a/:id', component: Blank },
      ]),
      { provide: PlayerService, useValue: player },
      { provide: ItemsService, useValue: { clock: (s: number) => `${Math.floor(s / 60)}m` } },
      { provide: ReaderService, useValue: new FakeReader() },
    ],
  });
  const fixture = TestBed.createComponent(MiniPlayer);
  fixture.detectChanges();
  const root = document.documentElement;
  const bar = () => fixture.nativeElement.querySelector('aside') as HTMLElement | null;
  return { fixture, player, root, bar, router: TestBed.inject(Router) };
}

describe('MiniPlayer (#179)', () => {
  afterEach(() => document.documentElement.style.removeProperty('--mini-player-height'));

  it('shows while an episode is in hand, and leaves room for itself', async () => {
    const { fixture, player, root, bar } = setup();
    expect(bar()).toBeNull();
    expect(root.style.getPropertyValue('--mini-player-height')).toBe('');
    player.item.set(episode);
    await fixture.whenStable();
    expect(bar()?.textContent).toContain('Reduction firing');
    expect(bar()?.textContent).toContain('12m / 42m');
    expect(root.style.getPropertyValue('--mini-player-height')).toContain('64px');
    (bar()!.querySelector('[aria-label="Play"]') as HTMLButtonElement).click();
    expect(player.toggle).toHaveBeenCalled();
    (bar()!.querySelector('[aria-label="Back 15 seconds"]') as HTMLButtonElement).click();
    expect(player.skip).toHaveBeenCalledWith(-15);
  });

  it('offers another device’s place in place of the time', async () => {
    const { fixture, player, bar } = setup();
    player.item.set(episode);
    player.offer.set(1200);
    await fixture.whenStable();
    const offer = [...bar()!.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Continue from 20m'),
    );
    expect(offer).toBeTruthy();
    offer!.click();
    expect(player.takeOffer).toHaveBeenCalled();
  });

  it('yields on the episode’s own page, which has the full controls', async () => {
    const { fixture, player, root, bar, router } = setup();
    player.item.set(episode);
    await router.navigateByUrl('/reader/a/e1?in=f:podcasts');
    await fixture.whenStable();
    expect(bar()).toBeNull();
    expect(root.style.getPropertyValue('--mini-player-height')).toBe('');
    await router.navigateByUrl('/reader');
    await fixture.whenStable();
    expect(bar()).not.toBeNull();
  });
});
