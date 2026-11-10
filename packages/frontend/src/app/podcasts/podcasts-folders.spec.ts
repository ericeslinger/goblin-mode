import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ModulesService } from '../modules/modules.service';
import { DownloadsService } from '../reader/downloads.service';
import { type ItemRecord, ItemsService } from '../reader/items.service';
import { type FeedRecord, ReaderService } from '../reader/reader.service';
import { FakeDownloads, FakeItems, FakeModules, FakeReader } from '../testing/fakes';
import { PodcastsFolders } from './podcasts-folders';

const show = (id: string, title: string, folders: string[]): FeedRecord => ({
  id,
  url: `https://${id}.test/f`,
  title,
  folders,
  dead: false,
  kind: 'podcast',
});
const ep = (id: string, feedId: string, published: number, played = false): ItemRecord => ({
  id,
  feedId,
  title: id,
  link: '',
  published,
  summary: '',
  content: '',
  read: false,
  saved: false,
  ...(played ? { played } : {}),
});

async function open() {
  const reader = new FakeReader();
  reader.feeds.set([
    show('p1', 'Kiln talk', ['Making']),
    show('p2', 'Small tools', ['Making', 'Tabletop']),
    show('p3', 'Dice and paper', ['Tabletop']),
    show('p4', 'Margin notes', []),
  ]);
  const items = new FakeItems();
  items.episodes.set([
    ep('a', 'p2', 400),
    ep('b', 'p1', 300),
    ep('c', 'p1', 200),
    ep('d', 'p3', 100, true),
    ep('e', 'p4', 50),
  ]);
  const modules = new FakeModules();
  modules.set('podcasts', true);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'podcasts/folders', component: PodcastsFolders }]),
      { provide: ReaderService, useValue: reader },
      { provide: ItemsService, useValue: items },
      { provide: DownloadsService, useValue: new FakeDownloads() },
      { provide: ModulesService, useValue: modules },
    ],
  });
  const harness = await RouterTestingHarness.create('/podcasts/folders');
  const el = harness.routeNativeElement!;
  const sections = () =>
    [...el.querySelectorAll('section')].map((s) => ({
      name: s.getAttribute('aria-label'),
      line: s.querySelector('.head .meta')!.textContent!.trim(),
      href: s.querySelector('.head')!.getAttribute('href'),
      shows: [...s.querySelectorAll('.strip a')].map((a) => a.getAttribute('aria-label')),
    }));
  const button = (name: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent!.replace(/\s+/g, ' ').trim() === name,
    )!;
  return { harness, el, reader, sections, button };
}

describe('Shows by folder (#246)', () => {
  it('has a section per folder, its counts, its grid and a strip of its shows; none last', async () => {
    const { el, sections } = await open();
    expect(el.textContent).toContain('4 shows in 2 folders');
    expect(sections()).toEqual([
      {
        name: 'Making',
        line: '2 shows · 3 unheard',
        href: '/podcasts/shows?folder=Making',
        shows: ['Small tools', 'Kiln talk'],
      },
      {
        name: 'Tabletop',
        line: '2 shows · 1 unheard',
        href: '/podcasts/shows?folder=Tabletop',
        shows: ['Small tools', 'Dice and paper'],
      },
      {
        name: 'Not in a folder',
        line: '1 show · 1 unheard',
        href: '/podcasts/shows?folder=Uncategorized',
        shows: ['Margin notes'],
      },
    ]);
    expect(el.querySelector('section .strip')?.getAttribute('aria-label')).toBe('Shows in Making');
    expect(el.querySelector('a[aria-label="Shows as one grid"]')?.getAttribute('href')).toBe(
      '/podcasts/shows',
    );
    // The Shows tab leads here.
    expect(
      el.querySelector('nav[aria-label="Podcasts screens"] a[aria-current="true"]')?.textContent,
    ).toContain('Shows');
  });

  it('makes a new folder from the shows chosen, keeping their other folders, its name as the Reader keeps one', async () => {
    const { harness, el, reader, button } = await open();
    button('New folder').click();
    await harness.fixture.whenStable();
    const make = button('Make the folder');
    expect(make.disabled).toBe(true);
    const name = el.querySelector<HTMLInputElement>('#new-folder input:not([type])')!;
    name.value = 'All';
    name.dispatchEvent(new Event('input'));
    const picks = [...el.querySelectorAll<HTMLInputElement>('#new-folder input[type="checkbox"]')];
    // The grid's order: Small tools, Kiln talk, Dice and paper, Margin notes.
    picks[1].click();
    picks[3].click();
    await harness.fixture.whenStable();
    expect(make.disabled).toBe(false);
    make.click();
    await harness.fixture.whenStable();
    expect(reader.setFolders).toHaveBeenCalledWith('p1', ['Making', 'All (folder)']);
    expect(reader.setFolders).toHaveBeenCalledWith('p4', ['All (folder)']);
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      "A folder cannot be called 'All'; it is in 'All (folder)'.",
    );
    expect(el.querySelector('#new-folder')).toBeNull();
    expect([...el.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'))).toEqual([
      'All (folder)',
      'Making',
      'Tabletop',
    ]);
  });
});
