import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FakeDownloads } from '../testing/fakes';
import { DownloadsService } from './downloads.service';
import { EpisodePlayer } from './episode-player';
import { type ItemRecord, ItemsService } from './items.service';
import { PlayerService } from './player.service';

const episode: ItemRecord = {
  id: 'e1',
  feedId: 'p1',
  title: 'Reduction firing',
  link: '',
  published: 0,
  summary: '',
  content: '',
  read: false,
  saved: false,
  position: 754,
  enclosure: { url: 'https://pod.test/1.mp3', type: 'audio/mpeg', seconds: 2530 },
};

@Component({
  imports: [EpisodePlayer],
  template: `<app-episode-player [item]="item" />`,
})
class Host {
  readonly item = episode;
}

function setup() {
  const player = {
    current: signal<string | undefined>(undefined),
    playing: signal(false),
    position: signal(0),
    duration: signal(0),
    rate: signal(1),
    offer: signal<number | undefined>(undefined),
    load: vi.fn(),
    toggle: vi.fn(),
    seek: vi.fn(),
    skip: vi.fn(),
    nextRate: vi.fn(),
    takeOffer: vi.fn(),
  };
  const clock = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  TestBed.configureTestingModule({
    imports: [Host],
    providers: [
      { provide: PlayerService, useValue: player },
      { provide: ItemsService, useValue: { clock } },
      { provide: DownloadsService, useValue: new FakeDownloads() },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const region = () => el.querySelector('section[aria-label="Player"]')!;
  const names = () =>
    [...region().querySelectorAll('button')].map(
      (b) => b.getAttribute('aria-label') ?? b.textContent!.trim(),
    );
  const slider = () => region().querySelector<HTMLInputElement>('input[type="range"]')!;
  return { fixture, el, region, names, slider, player };
}

describe('The episode’s player (#179, laid out in #290)', () => {
  it('keeps its controls’ names: back 15, Play, on 30, then the speed', async () => {
    const { names, player, fixture, region } = setup();
    expect(names()).toEqual(['Back 15 seconds', 'Play', 'Forward 30 seconds', 'Speed 1×']);
    // Play is the one filled button, between the two skips.
    const play = region().querySelector('button.primary')!;
    expect(play.getAttribute('aria-label')).toBe('Play');
    expect(play.closest('.transport')).not.toBeNull();
    expect(region().querySelector('.speed button')?.textContent?.trim()).toBe('1×');
    player.current.set('e1');
    player.playing.set(true);
    player.position.set(754);
    player.duration.set(2530);
    player.rate.set(1.5);
    await fixture.whenStable();
    expect(names()).toEqual(['Back 15 seconds', 'Pause', 'Forward 30 seconds', 'Speed 1.5×']);
  });

  it('is still the native Position slider, with its value in words', () => {
    const { slider } = setup();
    const s = slider();
    expect(s.getAttribute('aria-label')).toBe('Position');
    expect(s.getAttribute('min')).toBe('0');
    expect(s.getAttribute('step')).toBe('1');
    expect(s.max).toBe('2530');
    // The kept place until the episode is in hand.
    expect(s.value).toBe('754');
    expect(s.getAttribute('aria-valuetext')).toBe('12:34 of 42:10');
  });

  it('shows elapsed and the total at the slider’s two ends, read as one phrase', () => {
    const { region } = setup();
    const times = region().querySelector('.times')!;
    expect(times.querySelector('.elapsed')?.textContent?.trim()).toBe('12:34');
    expect(times.querySelector('.total')?.textContent?.trim()).toBe('42:10');
    expect(times.textContent!.replace(/\s+/g, ' ').trim()).toBe('12:34 of 42:10');
    // After the slider, so the two ends sit under it.
    const slider = region().querySelector('input[type="range"]')!;
    expect(slider.compareDocumentPosition(times) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('seeks and skips through the app’s player, putting the episode in hand first', () => {
    const { region, slider, player } = setup();
    const s = slider();
    s.value = '900';
    s.dispatchEvent(new Event('input'));
    s.dispatchEvent(new Event('change'));
    expect(player.load).toHaveBeenCalledWith(episode, { autoplay: false });
    expect(player.seek).toHaveBeenCalledWith(900);
    region().querySelector<HTMLButtonElement>('[aria-label="Forward 30 seconds"]')!.click();
    expect(player.skip).toHaveBeenCalledWith(30);
    region().querySelector<HTMLButtonElement>('[aria-label="Speed 1×"]')!.click();
    expect(player.nextRate).toHaveBeenCalled();
  });
});
