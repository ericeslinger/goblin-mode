import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ModulesService } from '../modules/modules.service';
import { DownloadsService } from '../reader/downloads.service';
import { ItemsService } from '../reader/items.service';
import { ReaderService } from '../reader/reader.service';
import { FakeDownloads, FakeItems, FakeModules, FakeReader } from '../testing/fakes';
import { PodcastsShows } from './podcasts-shows';

function setup() {
  const reader = new FakeReader();
  reader.feeds.set([
    {
      id: 'p1',
      url: 'https://kiln.test/f',
      title: 'Kiln talk',
      folders: [],
      dead: false,
      kind: 'podcast',
      fetchedAt: 1,
    },
    { id: 'f1', url: 'https://blog.test/f', title: 'A blog', folders: [], dead: false },
    {
      id: 'p2',
      url: 'https://dice.test/f',
      title: 'Dice and paper',
      folders: [],
      dead: false,
      kind: 'podcast',
    },
  ]);
  const modules = new FakeModules();
  modules.set('podcasts', true);
  TestBed.configureTestingModule({
    imports: [PodcastsShows],
    providers: [
      provideRouter([]),
      { provide: ReaderService, useValue: reader },
      { provide: ItemsService, useValue: new FakeItems() },
      { provide: DownloadsService, useValue: new FakeDownloads() },
      { provide: ModulesService, useValue: modules },
    ],
  });
  const fixture = TestBed.createComponent(PodcastsShows);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const button = (name: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.getAttribute('aria-label') ?? b.textContent!.trim()).startsWith(name),
    )!;
  const names = () =>
    [...el.querySelectorAll('ul[aria-label="Shows"] .name')].map((n) => n.textContent);
  return { fixture, el, reader, button, names };
}

describe('Shows (#245)', () => {
  it('lists the shows in Podcasts by name, each opening its episodes', () => {
    const { el, names } = setup();
    expect(names()).toEqual(['Kiln talk', 'Dice and paper']);
    expect(el.querySelector('ul a')?.getAttribute('href')).toBe('/podcasts/s/p1');
    expect(el.textContent).toContain('0 episodes · 0 new');
    expect(el.textContent).toContain('Not looked at yet');
  });

  it('moves a show to the Reader from its More, and unfollows one', () => {
    const { fixture, el, reader, button, names } = setup();
    const more = button('More for Kiln talk');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.click();
    fixture.detectChanges();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('[role="group"][aria-label="Kiln talk"]')).not.toBeNull();
    button('Move to the Reader').click();
    fixture.detectChanges();
    expect(reader.setPodcast).toHaveBeenCalledWith('p1', false);
    expect(names()).toEqual(['Dice and paper']);
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'Kiln talk is in the Reader now.',
    );
    button('More for Dice and paper').click();
    fixture.detectChanges();
    button('Unfollow').click();
    fixture.detectChanges();
    expect(reader.removeFeed).toHaveBeenCalledWith('p2');
    expect(names()).toEqual([]);
  });
});
