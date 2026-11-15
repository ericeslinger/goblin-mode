import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ModulesService } from '../modules/modules.service';
import { NOW } from '../platform/platform';
import { FakeModules } from '../testing/fakes';
import { ReaderFeeds } from './reader-feeds';
import { type FeedRecord, ReaderService } from './reader.service';

describe('ReaderFeeds’ status lines (review on #194)', () => {
  it('drops the folder editor’s line once another status is set', () => {
    const feed: FeedRecord = {
      id: 'f1',
      url: 'https://a.test/f',
      title: 'A',
      folders: [],
      dead: false,
    };
    const reader = {
      loaded: signal(true),
      feeds: signal([feed]),
      readerFeeds: signal([feed]),
      folders: signal([{ name: 'Uncategorized', feeds: [feed] }]),
      folderNames: signal(['Uncategorized']),
      setFolders: vi.fn(),
      addFeed: vi.fn(() => 'f2'),
      followed: vi.fn(() => undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ReaderService, useValue: reader },
        { provide: ModulesService, useValue: new FakeModules() },
      ],
    });
    const page = TestBed.createComponent(ReaderFeeds).componentInstance as unknown as {
      move(feed: FeedRecord, value: string): void;
      follow(event: Event, url: HTMLInputElement, folder: HTMLInputElement): void;
      moved(): string;
    };
    page.move(feed, 'Saved');
    expect(page.moved()).toMatch(/^A folder cannot be called 'Saved'/);
    const input = (value: string) => Object.assign(document.createElement('input'), { value });
    page.follow(new Event('submit'), input('https://b.test/f'), input(''));
    expect(page.moved()).toBe('');
  });

  it('moves a feed to Podcasts, and the Reader’s Follow never makes one (#245)', () => {
    const feed: FeedRecord = {
      id: 'f1',
      url: 'https://a.test/f',
      title: 'A',
      folders: [],
      dead: false,
    };
    const reader = {
      loaded: signal(true),
      feeds: signal([feed]),
      readerFeeds: signal([feed]),
      folders: signal([{ name: 'Uncategorized', feeds: [feed] }]),
      folderNames: signal(['Uncategorized']),
      setPodcast: vi.fn(),
      addFeed: vi.fn((..._args: unknown[]) => 'f2'),
      followed: vi.fn(() => undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ReaderService, useValue: reader },
        { provide: ModulesService, useValue: new FakeModules() },
      ],
    });
    const fixture = TestBed.createComponent(ReaderFeeds);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('button[aria-label="Move to Podcasts: A"]')!.click();
    fixture.detectChanges();
    expect(reader.setPodcast).toHaveBeenCalledWith('f1', true);
    expect(el.textContent).toContain('A is in Podcasts now.');
    const page = fixture.componentInstance as unknown as {
      follow(event: Event, url: HTMLInputElement, folder: HTMLInputElement): void;
    };
    const input = (value: string) => Object.assign(document.createElement('input'), { value });
    page.follow(new Event('submit'), input('https://b.test/f'), input('Games'));
    expect(reader.addFeed).toHaveBeenCalledWith('https://b.test/f', 'Games');
  });
});

describe('ReaderFeeds: feeds that need attention, and each row’s address (2026-11-15)', () => {
  const NOW_MS = Date.parse('2026-11-15T12:00:00Z');
  const make = (over: Partial<FeedRecord>): FeedRecord => ({
    id: 'f',
    url: 'https://f.test/feed',
    title: 'F',
    folders: ['Friends'],
    dead: false,
    fetchedAt: NOW_MS - 3_600_000,
    ...over,
  });
  const feeds = [
    make({ id: 'ok', title: 'Fine', url: 'https://fine.test/rss' }),
    make({ id: 'gone', title: 'Bygone', dead: true, error: 'getaddrinfo ENOTFOUND b.test' }),
    make({ id: 'shut', title: 'Closed', error: 'the site answered 403' }),
    make({
      id: 'moved',
      title: 'Live laugh',
      url: 'https://livelaugh.blog/feed',
      error: 'the site answered 404',
      errorCount: 4,
    }),
  ];

  function setup(list: FeedRecord[]) {
    const reader = {
      loaded: signal(true),
      feeds: signal(list),
      readerFeeds: signal(list),
      folders: signal([{ name: 'Friends', feeds: list }]),
      folderNames: signal(['Friends']),
      followed: vi.fn((): FeedRecord | undefined => undefined),
      discover: vi.fn(async () => [{ url: 'https://livelaugh.blog/rss.xml', title: 'Live Laugh' }]),
      switchFeed: vi.fn(() => ({ id: 'new', title: 'Live laugh', known: false })),
      retry: vi.fn(),
      removeFeed: vi.fn(),
      setFolders: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ReaderService, useValue: reader },
        { provide: ModulesService, useValue: new FakeModules() },
        { provide: NOW, useValue: () => NOW_MS },
      ],
    });
    const fixture = TestBed.createComponent(ReaderFeeds);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (label: string) =>
      el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    return { reader, fixture, el, button };
  }

  it('lists the failing feeds above the folders, the fixable first, each with its address, words and fixes', () => {
    const { el, button } = setup(feeds);
    const section = el.querySelector('section[aria-labelledby="attention"]')!;
    expect(section.querySelector('h2')!.textContent).toBe('Feeds that need attention');
    const rows = [...section.querySelectorAll(':scope > ul > li')];
    expect(rows.map((r) => r.querySelector('.name')!.textContent!.trim())).toEqual([
      'Live laugh',
      'Closed',
      'Bygone',
    ]);
    expect(rows[0].querySelector('.url')!.textContent).toBe('https://livelaugh.blog/feed');
    expect(rows[0].querySelector('.name')!.getAttribute('href')).toBe('/reader/s/moved');
    expect(rows[0].textContent).toContain('The address answers 404: nothing is there now.');
    expect(rows[0].textContent).toContain('4 looks in a row have failed, the last 1 h ago.');
    expect(rows[1].textContent).toContain(
      'The site does not let Mossgoblin read it (it answered 403).',
    );
    expect(rows[2].textContent).toContain('Given up after a month of failed looks.');
    // The fixes that fit each.
    const fixes = (row: Element) =>
      [...row.querySelectorAll('.fixes button')].map((b) => b.textContent!.trim());
    expect(fixes(rows[0])).toEqual(['Find the feed', 'Remove']);
    expect(fixes(rows[1])).toEqual(['Try again', 'Remove']);
    expect(fixes(rows[2])).toEqual(['Try again', 'Find the feed', 'Remove']);
    expect(button('Try Closed again')).toBeTruthy();
    // Above the folders.
    const headings = [...el.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings.indexOf('Feeds that need attention')).toBeLessThan(headings.indexOf('Folders'));
  });

  it('finds the feed at the site’s home page and switches to it in one tap', async () => {
    const { reader, fixture, el, button } = setup(feeds);
    button('Find the feed for Live laugh').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(reader.discover).toHaveBeenCalledWith('https://livelaugh.blog/');
    const found = el.querySelector('ul[aria-label="Feeds found for Live laugh"]')!;
    expect(found.textContent).toContain('https://livelaugh.blog/rss.xml');
    expect(el.textContent).toContain('Found a feed at livelaugh.blog.');
    button('Switch Live laugh to Live Laugh').click();
    fixture.detectChanges();
    expect(reader.switchFeed).toHaveBeenCalledWith('moved', {
      url: 'https://livelaugh.blog/rss.xml',
      title: 'Live Laugh',
    });
    expect(el.querySelector('[role="status"]')!.textContent).toContain(
      'Switched Live laugh to https://livelaugh.blog/rss.xml.',
    );
  });

  it('tries again and asks before removing', () => {
    const { reader, fixture, el, button } = setup(feeds);
    button('Try Closed again').click();
    fixture.detectChanges();
    expect(reader.retry).toHaveBeenCalledWith('shut');
    expect(el.querySelector('[role="status"]')!.textContent).toContain(
      'Closed will be looked at on the server’s next round',
    );
    button('Remove Bygone').click();
    fixture.detectChanges();
    expect(reader.removeFeed).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Remove Bygone? Its articles go with it');
    [...el.querySelectorAll<HTMLButtonElement>('.confirm button')]
      .find((b) => b.textContent!.trim() === 'Remove Bygone')!
      .click();
    expect(reader.removeFeed).toHaveBeenCalledWith('gone');
  });

  it('says so in one line when every feed answered, and shows each row’s address and its page link', () => {
    const { el } = setup([feeds[0]]);
    expect(el.querySelector('section[aria-labelledby="attention"]')).toBeNull();
    expect(el.textContent).toContain('Every feed answered at its last look.');
    const row = el.querySelector('ul[aria-label="Feeds in Friends"] li')!;
    expect(row.querySelector('.url')!.textContent).toBe('https://fine.test/rss');
    expect(row.querySelector('a.name')!.getAttribute('href')).toBe('/reader/s/ok');
  });
});
