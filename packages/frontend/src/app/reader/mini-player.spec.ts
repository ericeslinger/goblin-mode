import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { FakeReader } from '../testing/fakes';
import type { ItemRecord } from './items.service';
import { ItemsService } from './items.service';
import { MINI_PLAYER_HEIGHT, MiniPlayer } from './mini-player';
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

function setup(reader = new FakeReader()) {
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
        { path: 'podcasts/e/:id', component: Blank },
      ]),
      { provide: PlayerService, useValue: player },
      { provide: ItemsService, useValue: { clock: (s: number) => `${Math.floor(s / 60)}m` } },
      { provide: ReaderService, useValue: reader },
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

  it('has round icon buttons with their names, and a drawn line for how far along (#290)', async () => {
    const { fixture, player, bar, root } = setup();
    player.item.set(episode);
    await fixture.whenStable();
    const buttons = [...bar()!.querySelectorAll('.controls button')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Back 15 seconds',
      'Play',
      'Forward 30 seconds',
      'Close the player',
    ]);
    // Each draws a mark, not a character standing in for one.
    for (const b of buttons) expect(b.querySelector('app-icon')).not.toBeNull();
    expect(bar()!.querySelector('button.primary')?.getAttribute('aria-label')).toBe('Play');
    player.playing.set(true);
    await fixture.whenStable();
    expect(bar()!.querySelector('button.primary')?.getAttribute('aria-label')).toBe('Pause');
    // 754 of 2530 seconds; drawn only, the time in words beside the title.
    const line = bar()!.querySelector('.progress')!;
    expect(line.getAttribute('role')).toBe('presentation');
    expect((line.firstElementChild as HTMLElement).style.width).toMatch(/^29\.8\d*%$/);
    expect(bar()!.querySelector('.time')?.textContent).toContain('12m / 42m');
    // The bar's height is what it was: the line is inside it.
    expect(root.style.getPropertyValue('--mini-player-height')).toBe(MINI_PLAYER_HEIGHT);
    (bar()!.querySelector('[aria-label="Close the player"]') as HTMLButtonElement).click();
    expect(player.stop).toHaveBeenCalled();
  });

  it('draws the show’s initials where an episode has no artwork, or it fails (#290)', async () => {
    const reader = new FakeReader();
    reader.feeds.set([
      {
        id: 'pod',
        url: 'https://pod.test/f',
        title: 'Kiln hour',
        folders: [],
        dead: false,
        kind: 'podcast',
      },
    ]);
    const { fixture, player, bar } = setup(reader);
    player.item.set(episode);
    await fixture.whenStable();
    expect(bar()!.querySelector('img')).toBeNull();
    expect(bar()!.querySelector('.square')?.textContent?.trim()).toBe('KH');
    expect(bar()!.querySelector('.square')?.getAttribute('aria-hidden')).toBe('true');
    // Its own artwork while it loads; the square again once it fails.
    player.item.set({ ...episode, image: 'https://pod.test/e1.jpg' });
    await fixture.whenStable();
    const img = bar()!.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://pod.test/e1.jpg');
    expect(img.getAttribute('alt')).toBe('');
    img.dispatchEvent(new Event('error'));
    await fixture.whenStable();
    expect(bar()!.querySelector('img')).toBeNull();
    expect(bar()!.querySelector('.square')?.textContent?.trim()).toBe('KH');
  });

  it('takes its room back when the shell removes it after Close (#290)', async () => {
    const { fixture, player, root } = setup();
    player.item.set(episode);
    await fixture.whenStable();
    expect(root.style.getPropertyValue('--mini-player-height')).toBe(MINI_PLAYER_HEIGHT);
    // Close clears the presence, and the shell's @if destroys the bar
    // before its effect can run again.
    fixture.destroy();
    expect(root.style.getPropertyValue('--mini-player-height')).toBe('');
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
    await router.navigateByUrl('/reader/a/e1?in=s:pod');
    await fixture.whenStable();
    expect(bar()).toBeNull();
    expect(root.style.getPropertyValue('--mini-player-height')).toBe('');
    await router.navigateByUrl('/reader');
    await fixture.whenStable();
    expect(bar()).not.toBeNull();
  });

  it('opens a show’s episode in Podcasts, and yields on its page there (#245)', async () => {
    const reader = new FakeReader();
    reader.feeds.set([
      {
        id: 'pod',
        url: 'https://pod.test/f',
        title: 'Pod',
        folders: [],
        dead: false,
        kind: 'podcast',
      },
    ]);
    const { fixture, player, bar, router } = setup(reader);
    player.item.set(episode);
    await fixture.whenStable();
    expect(bar()!.querySelector('a.title')!.getAttribute('href')).toBe('/podcasts/e/e1');
    await router.navigateByUrl('/podcasts/e/e1');
    await fixture.whenStable();
    expect(bar()).toBeNull();
  });

  it('opens a Reader feed’s episode on its article page, back to the feed', async () => {
    const { fixture, player, bar } = setup();
    player.item.set(episode);
    await fixture.whenStable();
    expect(bar()!.querySelector('a.title')!.getAttribute('href')).toMatch(
      /^\/reader\/a\/e1\?in=s(:|%3A)pod$/,
    );
  });
});
