import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ModulesService } from '../modules/modules.service';
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
