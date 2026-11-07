import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW } from '../platform/platform';
import { ReadingService } from '../reading/reading.service';
import {
  FakeDownloadsApi,
  FakeItemsApi,
  FakeModules,
  FakeNotes,
  FakeReaderApi,
  FakeSettingsApi,
  fakeFirebase,
} from '../testing/fakes';
import { SETTINGS_API } from '../theme/theme-sync.service';
import { DOWNLOADS_API } from './downloads.service';
import { ITEMS_API } from './items.service';
import { Reader } from './reader';
import { READER_API } from './reader.service';

const NOW_MS = Date.parse('2026-11-07T12:00:00Z');

function setup() {
  const feeds = new FakeReaderApi();
  const modules = new FakeModules();
  modules.set('reader', true);
  TestBed.configureTestingModule({
    imports: [Reader],
    providers: [
      provideRouter([]),
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: ITEMS_API, useValue: new FakeItemsApi() },
      { provide: NotesService, useValue: new FakeNotes() },
      { provide: ReadingService, useValue: { save: vi.fn() } },
      { provide: READER_API, useValue: feeds },
      { provide: SETTINGS_API, useValue: new FakeSettingsApi() },
      { provide: ModulesService, useValue: modules },
      { provide: DOWNLOADS_API, useValue: new FakeDownloadsApi() },
      { provide: AuthService, useValue: { user: signal<User | null>({ uid: 'u1' } as User) } },
      { provide: NOW, useValue: () => NOW_MS },
    ],
  });
  const fixture = TestBed.createComponent(Reader);
  fixture.detectChanges();
  feeds.push([
    { id: 'f1', data: { url: 'https://a.test/f', title: 'Design notes', folders: ['Design'] } },
  ]);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const search = async (text: string) => {
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Search articles"]')!;
    input.value = text;
    el.querySelector<HTMLFormElement>('form[role=search]')!.requestSubmit();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, feeds, el, search };
}

describe('Reader front, search articles (#175)', () => {
  it('lists what the server found across every article, linking to each', async () => {
    const { feeds, el, search } = setup();
    feeds.searchArticles.mockResolvedValueOnce([
      {
        id: 'i1',
        feedId: 'f1',
        title: 'Three chairs',
        link: 'https://design.test/chairs',
        published: NOW_MS - 2 * 86_400_000,
        summary: 'A look',
        read: true,
        saved: false,
      },
      {
        id: 'i2',
        feedId: 'gone',
        title: 'A chair, again',
        link: '',
        published: NOW_MS - 3 * 3_600_000,
        summary: '',
        read: false,
        saved: false,
      },
    ]);
    await search(' chairs ');
    expect(feeds.searchArticles).toHaveBeenCalledWith('chairs', 20);
    const rows = [...el.querySelectorAll('ul[aria-label="Articles found"] li')];
    const text = (r: Element, part: string) =>
      r.querySelector(part)!.textContent!.replace(/\s+/g, ' ').trim();
    expect(rows.map((r) => [text(r, '.title'), text(r, '.count')])).toEqual([
      ['Three chairs', 'Design notes · 2 days ago'],
      ['A chair, again', 'Unknown feed · 3 h ago'],
    ]);
    expect(rows[0].querySelector('a')!.getAttribute('href')).toBe('/reader/a/i1');
  });

  it('says when nothing is found, or why it could not look', async () => {
    const { feeds, el, search } = setup();
    await search('zebra');
    expect(el.textContent).toContain('Nothing found.');
    expect(el.querySelector('ul[aria-label="Articles found"]')).toBeNull();
    feeds.searchArticles.mockRejectedValueOnce(new Error('offline'));
    await search('zebra');
    expect(el.textContent).toContain('Could not search. Are you online?');
    expect(el.textContent).not.toContain('Nothing found.');
    // An empty search asks nothing.
    feeds.searchArticles.mockClear();
    await search('   ');
    expect(feeds.searchArticles).not.toHaveBeenCalled();
  });
});
