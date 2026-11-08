import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FEED_CAP, feedId } from '@mossgoblin/schema';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { SETTINGS_API } from '../theme/theme-sync.service';
import { FakeModules, FakeReaderApi, FakeSettingsApi, fakeFirebase } from '../testing/fakes';
import { renamedFolder } from './reader-feeds';
import { READER_API, ReaderService, cleanFolder } from './reader.service';

const OPML = `<opml><body>
  <outline text="Design">
    <outline text="Kottke" xmlUrl="https://kottke.org/main/index.xml" htmlUrl="https://kottke.org/"/>
  </outline>
  <outline text="Games">
    <outline text="Kottke" xmlUrl="https://kottke.org/main/index.xml"/>
    <outline text="Dice" xmlUrl="https://dice.example/feed"/>
  </outline>
</body></opml>`;

function setup() {
  const api = new FakeReaderApi();
  const settings = new FakeSettingsApi();
  const modules = new FakeModules();
  modules.set('reader', true);
  const user = signal<User | null | undefined>({ uid: 'u1' } as User);
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: READER_API, useValue: api },
      { provide: SETTINGS_API, useValue: settings },
      { provide: ModulesService, useValue: modules },
      { provide: AuthService, useValue: { user } },
    ],
  });
  const reader = TestBed.inject(ReaderService);
  TestBed.tick();
  return { reader, api, user, settings, modules };
}

describe('ReaderService (#159)', () => {
  it('lists the feeds by folder, Uncategorized last', () => {
    const { reader, api } = setup();
    expect(api.listen.mock.calls[0][1]).toBe('users/u1/feeds');
    expect(reader.loaded()).toBe(false);
    api.push([
      { id: 'a', data: { url: 'https://a.test/f', title: 'Alpha', folders: ['Games'] } },
      { id: 'b', data: { url: 'https://b.test/f', title: 'Beta', folders: [], dead: true } },
    ]);
    expect(reader.loaded()).toBe(true);
    expect(reader.folders().map((f) => [f.name, f.feeds.map((x) => x.id)])).toEqual([
      ['Games', ['a']],
      ['Uncategorized', ['b']],
    ]);
    expect(reader.feeds()[1].dead).toBe(true);
  });

  it('imports an OPML file once: twice is known, folders union', () => {
    const { reader, api } = setup();
    api.push([]);
    expect(reader.importOpml(OPML)).toEqual({ added: 2, known: 0, refused: 0 });
    const kottke = feedId('https://kottke.org/main/index.xml');
    const [, path, data, merge] = api.set.mock.calls[0];
    expect(path).toBe(`users/u1/feeds/${kottke}`);
    expect(merge).toBe(false);
    expect(data).toMatchObject({
      url: 'https://kottke.org/main/index.xml',
      title: 'Kottke',
      site: 'https://kottke.org/',
      folders: ['Design', 'Games'],
      nextFetchAt: 'SERVER_TIME',
    });
    expect(api.set).toHaveBeenCalledTimes(2);
    // Again, with a folder the first file did not have.
    expect(reader.importOpml(OPML.replace('Design', 'Art'))).toEqual({
      added: 0,
      known: 2,
      refused: 0,
    });
    expect(api.set).toHaveBeenCalledTimes(3);
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      `users/u1/feeds/${kottke}`,
      { folders: ['Design', 'Games', 'Art'], updatedAt: 'SERVER_TIME' },
      true,
    ]);
    expect(reader.importOpml('<opml><body/></opml>')).toBeUndefined();
  });

  it('refuses feeds past the cap', () => {
    const { reader, api } = setup();
    api.push(
      Array.from({ length: FEED_CAP - 1 }, (_, i) => ({
        id: `f${i}`,
        data: { url: `https://x.test/${i}`, title: `${i}`, folders: [] },
      })),
    );
    expect(reader.importOpml(OPML)).toEqual({ added: 1, known: 0, refused: 1 });
    expect(reader.addFeed('https://one.more/feed')).toBeUndefined();
  });

  it('adds one feed by its link, moves it, and removes it', () => {
    const { reader, api } = setup();
    api.push([]);
    expect(reader.addFeed('ftp://nope')).toBeUndefined();
    const id = reader.addFeed(' https://dice.example/feed#x ', 'Games');
    expect(id).toBe(feedId('https://dice.example/feed'));
    expect(api.set.mock.lastCall![2]).toMatchObject({
      url: 'https://dice.example/feed',
      title: 'dice.example',
      folders: ['Games'],
    });
    // Known already: into the folder, not a second feed.
    expect(reader.addFeed('https://dice.example/feed', 'Design')).toBe(id);
    expect(api.set).toHaveBeenCalledTimes(2);
    expect(api.set.mock.lastCall![2]).toEqual({
      folders: ['Games', 'Design'],
      updatedAt: 'SERVER_TIME',
    });
    reader.setFolders(id!, [' Art ', 'Art', '']);
    expect(api.set.mock.lastCall![2]).toEqual({ folders: ['Art'], updatedAt: 'SERVER_TIME' });
    expect(reader.folderNames()).toEqual(['Art']);
    reader.removeFeed(id!);
    expect(api.remove).toHaveBeenCalledWith({}, `users/u1/feeds/${id}`);
    expect(reader.feeds()).toEqual([]);
  });

  it('renames a folder that takes a special shelf’s name, in any letter case (#185)', () => {
    expect(cleanFolder(' saved ')).toBe('saved (folder)');
    expect(cleanFolder('ALL')).toBe('ALL (folder)');
    expect(cleanFolder('Podcasts')).toBe('Podcasts (folder)');
    // Only the whole name; Uncategorized already means no folder.
    expect(cleanFolder(' Saved games ')).toBe('Saved games');
    expect(cleanFolder('Uncategorized')).toBe('Uncategorized');
    expect(cleanFolder('saved (folder)')).toBe('saved (folder)');
    expect(renamedFolder(['Games', ' saved'])).toBe(
      "A folder cannot be called 'saved'; it is in 'saved (folder)'.",
    );
    expect(renamedFolder(['Games', ''])).toBe('');
  });

  it('keeps a special name from a folder when following, moving or importing (#185)', () => {
    const { reader, api } = setup();
    api.push([]);
    const id = reader.addFeed('https://dice.example/feed', ' All ');
    expect(api.set.mock.lastCall![2]).toMatchObject({ folders: ['All (folder)'] });
    // Known already: the renamed folder is the one it is in.
    reader.addFeed('https://dice.example/feed', 'all');
    expect(api.set.mock.lastCall![2]).toMatchObject({ folders: ['All (folder)', 'all (folder)'] });
    // Renamed, then once: the name already kept is not a second folder.
    reader.setFolders(id!, [' Podcasts', 'Games', 'Podcasts (folder)']);
    expect(api.set.mock.lastCall![2]).toEqual({
      folders: ['Podcasts (folder)', 'Games'],
      updatedAt: 'SERVER_TIME',
    });
    expect(reader.folderNames()).toEqual(['Games', 'Podcasts (folder)']);
    // An outline named Saved: the feed is kept, in Saved (folder).
    const opml = OPML.replace('"Design"', '"Saved"');
    expect(reader.importOpml(opml)).toEqual({ added: 1, known: 1, refused: 0 });
    const kottke = feedId('https://kottke.org/main/index.xml');
    expect(api.set.mock.calls.find((c) => c[1] === `users/u1/feeds/${kottke}`)![2]).toMatchObject({
      folders: ['Saved (folder)', 'Games'],
    });
    // Again: known, and no folder to add, so nothing is written.
    const writes = api.set.mock.calls.length;
    expect(reader.importOpml(opml)).toEqual({ added: 0, known: 2, refused: 0 });
    expect(api.set).toHaveBeenCalledTimes(writes);
    expect(reader.folderNames()).toEqual(['Games', 'Podcasts (folder)', 'Saved (folder)']);
  });

  it('refreshes through the server and says what came of it, or why not', async () => {
    const { reader, api } = setup();
    expect(await reader.refresh()).toBe('Looked at 2 feeds: 5 new articles.');
    api.refresh.mockResolvedValueOnce({ fetched: 1, added: 0, failed: 1, skipped: 0 });
    expect(await reader.refresh()).toBe('Looked at 1 feed: 0 new articles, 1 could not be read.');
    api.refresh.mockRejectedValueOnce(
      new Error('Refreshed a moment ago; the next is in 4 minutes.'),
    );
    expect(await reader.refresh()).toBe('Refreshed a moment ago; the next is in 4 minutes.');
    // The Firebase client puts the HTTP status after the server's words (#174).
    api.refresh.mockRejectedValueOnce(
      new Error('Refreshed a moment ago; the next is in 4 minutes. [429]'),
    );
    expect(await reader.refresh()).toBe('Refreshed a moment ago; the next is in 4 minutes.');
    api.refresh.mockRejectedValueOnce(new Error('internal'));
    expect(await reader.refresh()).toBe('Could not refresh. Are you online?');
  });

  it('discovers the feeds at a site through the server, or says why not (#174)', async () => {
    const { reader, api } = setup();
    expect(await reader.discover('not a link')).toMatch(/not a link/);
    expect(api.discoverFeeds).not.toHaveBeenCalled();
    expect(await reader.discover(' https://site.test/#top ')).toEqual([
      { url: 'https://site.test/posts.xml', title: 'Posts' },
      { url: 'https://site.test/games.atom', title: 'Dice' },
    ]);
    expect(api.discoverFeeds).toHaveBeenCalledWith('https://site.test/');
    api.discoverFeeds.mockRejectedValueOnce(new Error('No feed found at that address. [404]'));
    expect(await reader.discover('https://site.test/')).toBe('No feed found at that address.');
    api.discoverFeeds.mockRejectedValueOnce(
      new Error('Could not look at that address: the site answered 500'),
    );
    expect(await reader.discover('https://site.test/')).toMatch(/answered 500/);
    api.discoverFeeds.mockRejectedValueOnce(new Error('internal'));
    expect(await reader.discover('https://site.test/')).toBe('Could not look. Are you online?');
  });

  it('searches every article through the server, or says why not (#175)', async () => {
    const { reader, api } = setup();
    expect(await reader.search('   ')).toEqual({ items: [], truncated: false });
    expect(api.searchArticles).not.toHaveBeenCalled();
    const hit = {
      id: 'i1',
      feedId: 'f1',
      title: 'Three chairs',
      link: 'https://design.test/chairs',
      published: 1,
      summary: 'A look',
      read: true,
      saved: false,
    };
    api.searchArticles.mockResolvedValueOnce({ items: [hit] });
    expect(await reader.search('  three\n chairs ')).toEqual({ items: [hit], truncated: false });
    expect(api.searchArticles).toHaveBeenCalledWith('three chairs', 20);
    // The server stopped before the oldest (review on #197): said so.
    api.searchArticles.mockResolvedValueOnce({ items: [], truncated: true });
    expect(await reader.search('chairs')).toEqual({ items: [], truncated: true });
    api.searchArticles.mockRejectedValueOnce(new Error('internal'));
    expect(await reader.search('chairs')).toBe('Could not search. Are you online?');
    api.searchArticles.mockRejectedValueOnce(
      new Error('Today’s 500 searches are used up; try again tomorrow. [429]'),
    );
    expect(await reader.search('chairs')).toBe(
      'Today’s 500 searches are used up; try again tomorrow.',
    );
  });

  it('indexes the articles stored before the index, once a day (#175)', async () => {
    const { reader, api } = setup();
    expect(await reader.indexArticles()).toBe('Indexed 4 articles.');
    api.indexArticles.mockResolvedValueOnce({ indexed: 1 });
    expect(await reader.indexArticles()).toBe('Indexed 1 article.');
    api.indexArticles.mockRejectedValueOnce(
      new Error('Indexed today already; new articles are indexed as they arrive. [429]'),
    );
    expect(await reader.indexArticles()).toBe(
      'Indexed today already; new articles are indexed as they arrive.',
    );
    api.indexArticles.mockRejectedValueOnce(new Error('internal'));
    expect(await reader.indexArticles()).toBe('Could not index the articles. Are you online?');
  });

  it('follows a discovered feed under its own name; a known one keeps its name (#174)', () => {
    const { reader, api } = setup();
    api.push([
      {
        id: feedId('https://site.test/games.atom'),
        data: { url: 'https://site.test/games.atom', title: 'Games', folders: [] },
      },
    ]);
    const id = reader.addFeed('https://site.test/posts.xml', 'Design', ' Posts  and notes ');
    expect(id).toBe(feedId('https://site.test/posts.xml'));
    expect(api.set.mock.lastCall![2]).toMatchObject({
      url: 'https://site.test/posts.xml',
      title: 'Posts and notes',
      folders: ['Design'],
    });
    expect(reader.followed('https://site.test/games.atom')?.title).toBe('Games');
    expect(reader.followed('https://site.test/nope.xml')).toBeUndefined();
    reader.addFeed('https://site.test/games.atom', 'Tabletop', 'Dice');
    expect(api.set.mock.lastCall![2]).toEqual({ folders: ['Tabletop'], updatedAt: 'SERVER_TIME' });
    expect(reader.followed('https://site.test/games.atom')?.title).toBe('Games');
  });

  it('asks for a given-up feed again by clearing its errors and making it due', () => {
    const { reader, api } = setup();
    api.push([{ id: 'a', data: { url: 'https://a.test/f', title: 'A', folders: [], dead: true } }]);
    reader.retry('a');
    expect(reader.feeds()[0].dead).toBe(false);
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/feeds/a',
      {
        dead: 'CLEAR',
        error: 'CLEAR',
        errorCount: 0,
        nextFetchAt: 'SERVER_TIME',
        updatedAt: 'SERVER_TIME',
      },
      true,
    ]);
  });

  it('writes nothing before the feeds are read, so nothing known is written over', () => {
    const { reader, api } = setup();
    expect(reader.importOpml(OPML)).toBeUndefined();
    expect(reader.addFeed('https://dice.example/feed')).toBeUndefined();
    expect(api.set).not.toHaveBeenCalled();
    api.push([]);
    expect(reader.importOpml(OPML)?.added).toBe(2);
  });

  it('keeps the Reader’s settings: images on until switched off, written whole', () => {
    const { reader, settings } = setup();
    expect(settings.listen.mock.calls[0][1]).toBe('users/u1/settings/reader');
    expect(reader.images()).toBe(true);
    settings.push({ folderOrder: ['Games'], images: false, updatedAt: 1 });
    expect(reader.images()).toBe(false);
    reader.setImages(true);
    expect(reader.images()).toBe(true);
    expect(settings.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/settings/reader',
      { folderOrder: ['Games'], images: true, updatedAt: 'SERVER_TIME' },
    ]);
  });

  it('marks read on scroll only when switched on (#172), written whole', () => {
    const { reader, settings } = setup();
    expect(reader.readOnScroll()).toBe(false);
    settings.push({ folderOrder: ['Games'], images: false, updatedAt: 1 });
    expect(reader.readOnScroll()).toBe(false);
    reader.setReadOnScroll(true);
    expect(reader.readOnScroll()).toBe(true);
    expect(settings.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/settings/reader',
      { folderOrder: ['Games'], images: false, readOnScroll: true, updatedAt: 'SERVER_TIME' },
    ]);
    reader.setReadOnScroll(false);
    expect(reader.readOnScroll()).toBe(false);
    expect(settings.set.mock.lastCall![2]).toEqual({
      folderOrder: ['Games'],
      images: false,
      readOnScroll: false,
      updatedAt: 'SERVER_TIME',
    });
  });

  it('keeps when each folder was seen (#173), as millis, reading a Timestamp too', () => {
    const { reader, settings } = setup();
    expect(reader.settingsLoaded()).toBe(false);
    expect(reader.seenAt()).toEqual({});
    settings.push({
      folderOrder: [],
      images: true,
      seenAt: { Design: 1000, Games: { toMillis: () => 2000 }, Odd: 'soon' },
      updatedAt: 1,
    });
    expect(reader.settingsLoaded()).toBe(true);
    expect(reader.seenAt()).toEqual({ Design: 1000, Games: 2000 });
    reader.markSeen('Design', 5000);
    expect(reader.seenAt()['Design']).toBe(5000);
    const written = settings.set.mock.lastCall![2];
    expect(written['seenAt']).toMatchObject({ Design: 5000, Odd: 'soon' });
    expect(written).toMatchObject({ folderOrder: [], images: true, updatedAt: 'SERVER_TIME' });
  });

  it('keeps articles for a while (#171): the setting written whole, then applied by the server', async () => {
    const { reader, api, settings } = setup();
    settings.push({ folderOrder: ['Games'], images: false, readOnScroll: true, updatedAt: 1 });
    expect(await reader.setKeepMonths(3)).toBe(
      'Keeping articles for 3 months; applied to 7 stored articles.',
    );
    expect(reader.keepMonths()).toBe(3);
    expect(settings.set.mock.lastCall![2]).toEqual({
      folderOrder: ['Games'],
      images: false,
      readOnScroll: true,
      keepMonths: 3,
      updatedAt: 'SERVER_TIME',
    });
    expect(api.applyRetention).toHaveBeenCalledWith(3);
    expect(await reader.setKeepMonths(undefined)).toBe(
      'Keeping everything; 7 articles will no longer expire.',
    );
    expect(settings.set.mock.lastCall![2]).not.toHaveProperty('keepMonths');
    expect(api.applyRetention).toHaveBeenLastCalledWith(null);
    api.applyRetention.mockRejectedValueOnce(new Error('offline'));
    expect(await reader.setKeepMonths(6)).toMatch(/choose it again online/);
    expect(await reader.sweep()).toBe('Removed 3 old unread articles.');
  });

  it('listens to nothing while the module is off', () => {
    const { api, modules } = setup();
    expect(api.listen).toHaveBeenCalledTimes(1);
    modules.set('reader', false);
    TestBed.tick();
    expect(api.listen).toHaveBeenCalledTimes(1);
  });

  it('writes nothing while signed out', () => {
    const { reader, api, user } = setup();
    user.set(null);
    TestBed.tick();
    expect(reader.addFeed('https://dice.example/feed')).toBeUndefined();
    expect(reader.importOpml(OPML)).toBeUndefined();
    expect(api.set).not.toHaveBeenCalled();
  });
});
