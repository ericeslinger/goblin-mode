import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ModulesService } from '../modules/modules.service';
import { SAVE_FILE } from '../platform/platform';
import { DownloadsService } from '../reader/downloads.service';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { type FeedRecord, ReaderService } from '../reader/reader.service';
import { FakeDownloads, FakeItems, FakeModules, FakeReader } from '../testing/fakes';
import { PodcastsShows } from './podcasts-shows';

const show = (id: string, title: string, more: Partial<FeedRecord> = {}): FeedRecord => ({
  id,
  url: `https://${id}.test/f`,
  title,
  folders: [],
  dead: false,
  kind: 'podcast',
  fetchedAt: 1,
  ...more,
});
const ep = (id: string, feedId: string, published: number, more: Partial<ItemRecord> = {}) =>
  ({
    id,
    feedId,
    title: `Episode ${id}`,
    link: '',
    published,
    summary: '',
    content: '',
    read: false,
    saved: false,
    enclosure: { url: 'https://pod.test/x.mp3', type: 'audio/mpeg' },
    ...more,
  }) satisfies ItemRecord;

async function open(url = '/podcasts/shows') {
  const reader = new FakeReader();
  reader.feeds.set([
    show('p1', 'Kiln talk', { folders: ['Making'], image: 'https://kiln.test/show.jpg' }),
    { id: 'f1', url: 'https://blog.test/f', title: 'A blog', folders: [], dead: false },
    show('p2', 'Dice and paper', { folders: ['Tabletop'] }),
    show('p3', 'Margin notes', { lastItemAt: 50 }),
  ]);
  const items = new FakeItems();
  items.episodes.set([
    ep('d2', 'p2', 300, { image: 'https://dice.test/2.jpg' }),
    ep('k1', 'p1', 200),
    ep('k2', 'p1', 100, { played: true }),
    ep('d1', 'p2', 90, { position: 30 }),
  ]);
  const modules = new FakeModules();
  modules.set('podcasts', true);
  const save = vi.fn((_name: string, _type: string, _text: string) => undefined);
  Object.assign(reader, { podcastsOpml: () => '<opml>the shows</opml>' });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'podcasts/shows', component: PodcastsShows }]),
      { provide: SAVE_FILE, useValue: save },
      { provide: ReaderService, useValue: reader },
      { provide: ItemsService, useValue: items },
      { provide: DownloadsService, useValue: new FakeDownloads() },
      { provide: ModulesService, useValue: modules },
    ],
  });
  const harness = await RouterTestingHarness.create(url);
  const el = harness.routeNativeElement!;
  const squares = () =>
    [...el.querySelectorAll('ul[aria-label="Shows"] > li > a')].map((a) =>
      a.getAttribute('aria-label'),
    );
  const chip = (name: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Folders"] button')].find(
      (b) => b.textContent!.replace(/\s+/g, ' ').trim() === name,
    )!;
  return { harness, el, reader, items, squares, chip, save };
}

describe('Shows, the grid (#246)', () => {
  it('draws a square per show, newest episode first, with its unheard count', async () => {
    const { el, squares } = await open();
    // Dice (newest 300), Kiln (200), Margin (none at hand, the fetcher's 50); no Reader feed.
    expect(squares()).toEqual([
      'Dice and paper, 2 unheard',
      'Kiln talk, 1 unheard',
      'Margin notes',
    ]);
    expect(el.querySelector('ul a')?.getAttribute('href')).toBe('/podcasts/s/p2');
    const badges = [...el.querySelectorAll('ul .badge')].map((b) => b.textContent!.trim());
    expect(badges).toEqual(['2', '1']);
    expect(el.querySelector('ul .badge')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent).toContain('3 shows, newest episode first');
    // The feed's image, else its newest episode's; else its name on a tinted square.
    const art = [...el.querySelectorAll('ul > li')].map(
      (li) =>
        li.querySelector('img')?.getAttribute('src') ??
        li.querySelector('.square')?.textContent?.trim(),
    );
    expect(art).toEqual(['https://dice.test/2.jpg', 'https://kiln.test/show.jpg', 'Margin notes']);
    const img = el.querySelector('ul img')!;
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('loading')).toBe('lazy');
    // No per-show menus in the grid: More is on the show's page.
    expect(el.querySelector('button[aria-label^="More for"]')).toBeNull();
    expect(el.querySelector('a[aria-label="Shows by folder"]')?.getAttribute('href')).toBe(
      '/podcasts/folders',
    );
  });

  it('filters by a folder chip, kept in the address', async () => {
    const { harness, chip, squares, el } = await open();
    expect(chip('All 3').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Making')).toBeTruthy();
    expect(chip('Tabletop')).toBeTruthy();
    expect(chip('Not in a folder')).toBeTruthy();
    chip('Making').click();
    await harness.fixture.whenStable();
    expect(squares()).toEqual(['Kiln talk, 1 unheard']);
    expect(chip('Making').getAttribute('aria-pressed')).toBe('true');
    expect(el.textContent).toContain('1 show in Making, newest episode first');
    chip('Not in a folder').click();
    await harness.fixture.whenStable();
    expect(squares()).toEqual(['Margin notes']);
    chip('All 3').click();
    await harness.fixture.whenStable();
    expect(squares()).toHaveLength(3);
  });

  it('opens on the folder the address names, as the folder view links it', async () => {
    const { squares, chip } = await open('/podcasts/shows?folder=Tabletop');
    expect(squares()).toEqual(['Dice and paper, 2 unheard']);
    expect(chip('Tabletop').getAttribute('aria-pressed')).toBe('true');
  });

  it('falls back to the tinted square when the artwork fails to load', async () => {
    const { harness, el } = await open();
    const first = el.querySelector('ul > li')!;
    first.querySelector('img')!.dispatchEvent(new Event('error'));
    await harness.fixture.whenStable();
    expect(first.querySelector('img')).toBeNull();
    expect(first.querySelector('.square')?.textContent?.trim()).toBe('Dice and paper');
  });

  it('keeps Refresh', async () => {
    const { harness, el, reader } = await open();
    const refresh = [...el.querySelectorAll('button')].find(
      (b) => b.textContent!.trim() === 'Refresh',
    )!;
    refresh.click();
    await harness.fixture.whenStable();
    expect(reader.refresh).toHaveBeenCalled();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Looked at 0 feeds');
  });

  it('exports the shows as an OPML file (#251)', async () => {
    const { el, save, harness } = await open();
    const button = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent!.trim() === 'Export as OPML',
    )!;
    button.click();
    await harness.fixture.whenStable();
    expect(save).toHaveBeenCalledWith(
      'mossgoblin-podcasts.opml',
      'text/x-opml',
      '<opml>the shows</opml>',
    );
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Exported 3 shows as OPML.');
  });
});
