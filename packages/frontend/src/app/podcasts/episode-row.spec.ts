import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DownloadsService } from '../reader/downloads.service';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { PlayerService } from '../reader/player.service';
import { ReaderService } from '../reader/reader.service';
import { FakeDownloads, FakeItems, FakeReader } from '../testing/fakes';
import { EpisodeRow } from './episode-row';

const episode = (more: Partial<ItemRecord> = {}): ItemRecord => ({
  id: 'e1',
  feedId: 'p1',
  title: 'Reduction firing',
  link: '',
  published: 0,
  summary: '',
  content: '',
  read: false,
  saved: false,
  enclosure: { url: 'https://pod.test/1.mp3', type: 'audio/mpeg', seconds: 2520 },
  ...more,
});

@Component({
  imports: [EpisodeRow],
  template: `<ul aria-label="Episodes">
    <li appEpisodeRow [item]="item()" [show]="'Kiln talk'" [named]="named()"></li>
  </ul>`,
})
class Host {
  readonly item = signal(episode());
  readonly named = signal(true);
}

function setup() {
  const player = {
    current: signal<string | undefined>(undefined),
    playing: signal(false),
    position: signal(0),
    duration: signal(0),
    load: vi.fn(),
    toggle: vi.fn(),
  };
  const reader = new FakeReader();
  TestBed.configureTestingModule({
    imports: [Host],
    providers: [
      provideRouter([]),
      { provide: ItemsService, useValue: new FakeItems() },
      { provide: ReaderService, useValue: reader },
      { provide: PlayerService, useValue: player },
      { provide: DownloadsService, useValue: new FakeDownloads() },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const li = () => el.querySelector('ul > li')!;
  const buttons = () => [...li().querySelectorAll('button')];
  const names = () => buttons().map((b) => b.getAttribute('aria-label'));
  return { fixture, el, li, buttons, names, player, reader };
}

describe('An episode’s row (#290)', () => {
  it('is a list item with two buttons, Play on the artwork and Add to the queue', async () => {
    const { li, names, buttons, player, fixture } = setup();
    expect(li().tagName).toBe('LI');
    // The names the row's Play and queue buttons had before #290.
    expect(names()).toEqual(['Play Reduction firing', 'Add Reduction firing to the queue']);
    // Play holds the artwork; the row's text is the link to the episode.
    expect(buttons()[0].querySelector('app-episode-art')).not.toBeNull();
    expect(li().querySelector('a.open')?.getAttribute('href')).toBe('/podcasts/e/e1');
    buttons()[0].click();
    expect(player.load).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), {
      autoplay: true,
    });
    player.current.set('e1');
    player.playing.set(true);
    await fixture.whenStable();
    expect(names()[0]).toBe('Pause Reduction firing');
    buttons()[0].click();
    expect(player.toggle).toHaveBeenCalled();
  });

  it('puts the length after the age, in one piece, in the meta line', () => {
    const { li } = setup();
    const meta = li().querySelector('.meta')!;
    expect(meta.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'New · Kiln talk · just now · 42 min',
    );
    // In DOM order: the title, then the meta line, whose last piece
    // holds both the age and the length, so the length never stands
    // on a line alone.
    const parts = [...meta.querySelectorAll('.state, .part')].map((p) =>
      p.textContent!.replace(/\s+/g, ' ').trim(),
    );
    expect(parts).toEqual(['New', 'Kiln talk', 'just now · 42 min']);
    const title = li().querySelector('.title')!;
    expect(title.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Every piece is set apart by words, never run together.
    expect(meta.textContent).not.toMatch(/New\S|talk\S|min\S/);
  });

  it('leaves the show out on the show’s own page', async () => {
    const { li, fixture } = setup();
    fixture.componentInstance.named.set(false);
    await fixture.whenStable();
    expect(li().querySelector('.meta')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'New · just now · 42 min',
    );
  });

  it('draws a show with no artwork as its initials on a tinted square, hidden from readers', async () => {
    const { li, reader, fixture } = setup();
    reader.images.set(true);
    await fixture.whenStable();
    expect(li().querySelector('img')).toBeNull();
    const square = li().querySelector('.square')!;
    expect(square.textContent!.trim()).toBe('KT');
    expect(square.getAttribute('aria-hidden')).toBe('true');
    // The glyph on its corner is decoration too: the button is named.
    expect(li().querySelector('.glyph')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('with no audio, has no buttons, only the artwork and the link', async () => {
    const { names, li, fixture } = setup();
    fixture.componentInstance.item.set(episode({ enclosure: undefined }));
    await fixture.whenStable();
    expect(names()).toEqual([]);
    expect(li().querySelector('app-episode-art')).not.toBeNull();
    expect(li().querySelector('a.open')).not.toBeNull();
  });
});
