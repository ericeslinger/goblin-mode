import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FEED_CAP, feedId } from '@mossgoblin/schema';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { SETTINGS_API } from '../theme/theme-sync.service';
import { FakeModules, FakeReaderApi, FakeSettingsApi, fakeFirebase } from '../testing/fakes';
import { ReadingService } from '../reading/reading.service';
import { zipOf } from '../testing/zip';
import { renamedFolder } from './reader-feeds';
import {
  READER_API,
  ReaderService,
  SAVES_QUEUED,
  cleanFolder,
  podcastOpmlMessage,
} from './reader.service';

const OPML = `<opml><body>
  <outline text="Design">
    <outline text="Kottke" xmlUrl="https://kottke.org/main/index.xml" htmlUrl="https://kottke.org/"/>
  </outline>
  <outline text="Games">
    <outline text="Kottke" xmlUrl="https://kottke.org/main/index.xml"/>
    <outline text="Dice" xmlUrl="https://dice.example/feed"/>
  </outline>
</body></opml>`;

function setup(reading?: { save: (url: string) => string | undefined }) {
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
      ...(reading ? [{ provide: ReadingService, useValue: reading }] : []),
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
    expect(reader.importOpml(OPML)).toEqual({ added: 2, known: 0, elsewhere: 0, refused: 0 });
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
      elsewhere: 0,
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

  it('imports podcasts from OPML as shows (#251): queue off, a Reader feed left where it is', () => {
    const { reader, api } = setup();
    const kottke = feedId('https://kottke.org/main/index.xml');
    api.push([
      {
        id: kottke,
        data: { url: 'https://kottke.org/main/index.xml', title: 'Kottke', folders: [] },
      },
    ]);
    expect(reader.importOpml(OPML, { podcast: true })).toEqual({
      added: 1,
      known: 0,
      elsewhere: 1,
      refused: 0,
    });
    // Only the new one is written: the Reader's feed keeps its folders and kind.
    expect(api.set).toHaveBeenCalledTimes(1);
    const [, path, data] = api.set.mock.calls[0];
    expect(path).toBe(`users/u1/feeds/${feedId('https://dice.example/feed')}`);
    expect(data).toMatchObject({ kind: 'podcast', autoQueue: false, folders: ['Games'] });
    expect(reader.podcastFeeds().map((f) => f.title)).toEqual(['Dice']);
    // Twice is once.
    expect(reader.importOpml(OPML, { podcast: true })).toEqual({
      added: 0,
      known: 1,
      elsewhere: 1,
      refused: 0,
    });
    expect(api.set).toHaveBeenCalledTimes(1);
    expect(podcastOpmlMessage({ added: 3, known: 2, elsewhere: 1, refused: 0 })).toBe(
      '3 added, 1 already in the Reader, 2 already followed.',
    );
    // And the Reader's import leaves the show where it is, its folders too.
    expect(reader.importOpml(OPML)).toEqual({ added: 0, known: 1, elsewhere: 1, refused: 0 });
    expect(api.set).toHaveBeenCalledTimes(2);
    expect(api.set.mock.lastCall![1]).toBe(`users/u1/feeds/${kottke}`);
  });

  it('exports the shows as OPML, their folders as outlines (#251)', () => {
    const { reader, api } = setup();
    api.push([
      {
        id: 'p1',
        data: {
          url: 'https://kiln.test/rss',
          title: 'Kiln talk',
          folders: ['Making'],
          kind: 'podcast',
        },
      },
      {
        id: 'p2',
        data: { url: 'https://glaze.test/rss', title: 'Glaze lab', folders: [], kind: 'podcast' },
      },
      { id: 'r1', data: { url: 'https://blog.test/rss', title: 'A blog', folders: ['Making'] } },
    ]);
    const text = reader.podcastsOpml();
    expect(text).toContain('<outline text="Making" title="Making">');
    expect(text).toContain('xmlUrl="https://kiln.test/rss"');
    expect(text).toContain('xmlUrl="https://glaze.test/rss"');
    expect(text).not.toContain('blog.test');
  });

  it('hands back a Move’s write for a batch, shown at once (#251)', () => {
    const { reader, api } = setup();
    api.push([
      { id: 'p1', data: { url: 'https://kiln.test/rss', title: 'Kiln', kind: 'podcast' } },
    ]);
    expect(reader.kindWrite('p1', false)).toEqual({
      path: 'users/u1/feeds/p1',
      data: { kind: 'CLEAR', updatedAt: 'SERVER_TIME' },
    });
    expect(reader.podcastFeeds()).toEqual([]);
    expect(api.set).not.toHaveBeenCalled();
  });

  it('refuses feeds past the cap', () => {
    const { reader, api } = setup();
    api.push(
      Array.from({ length: FEED_CAP - 1 }, (_, i) => ({
        id: `f${i}`,
        data: { url: `https://x.test/${i}`, title: `${i}`, folders: [] },
      })),
    );
    expect(reader.importOpml(OPML)).toEqual({ added: 1, known: 0, elsewhere: 0, refused: 1 });
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
    expect(reader.importOpml(opml)).toEqual({ added: 1, known: 1, elsewhere: 0, refused: 0 });
    const kottke = feedId('https://kottke.org/main/index.xml');
    expect(api.set.mock.calls.find((c) => c[1] === `users/u1/feeds/${kottke}`)![2]).toMatchObject({
      folders: ['Saved (folder)', 'Games'],
    });
    // Again: known, and no folder to add, so nothing is written.
    const writes = api.set.mock.calls.length;
    expect(reader.importOpml(opml)).toEqual({ added: 0, known: 2, elsewhere: 0, refused: 0 });
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

  it('shows a switch just set over a snapshot from before it, until its echo (#224)', async () => {
    const { reader, settings } = setup();
    let refuse: (err: unknown) => void = () => undefined;
    const pending: (() => void)[] = [];
    settings.set.mockImplementation(
      () =>
        new Promise<void>((done, fail) => {
          pending.push(done);
          refuse = fail;
        }),
    );
    settings.push({ folderOrder: [], images: true, readOnScroll: true, updatedAt: 1 }, true);
    reader.setReadOnScroll(false);
    expect(reader.readOnScroll()).toBe(false);
    // The server's answer, made before the write and heard after it.
    settings.push({ folderOrder: [], images: true, readOnScroll: true, updatedAt: 1 });
    expect(reader.readOnScroll()).toBe(false);
    // A folder seen now is written with the switch as shown, not as stored.
    reader.markSeen('Design', 5000);
    expect(settings.set.mock.lastCall![2]).toMatchObject({
      readOnScroll: false,
      seenAt: { Design: 5000 },
    });
    // The first write's echo, made before the second: the switch is
    // heard back, the folder not yet.
    settings.push(
      { folderOrder: [], images: true, readOnScroll: false, updatedAt: 1 },
      false,
      true,
    );
    expect(reader.readOnScroll()).toBe(false);
    expect(reader.seenAt()).toEqual({ Design: 5000 });
    pending.splice(0).forEach((done) => done());
    await Promise.resolve();
    await Promise.resolve();
    // Heard back and acknowledged: another device's choice shows again.
    settings.push({ folderOrder: [], images: true, readOnScroll: true, updatedAt: 2 });
    expect(reader.readOnScroll()).toBe(true);
    expect(reader.seenAt()).toEqual({});
    // A refused write shows no longer.
    reader.setImages(false);
    expect(reader.images()).toBe(false);
    refuse(new Error('permission-denied'));
    await vi.waitFor(() => expect(reader.images()).toBe(true));
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

  it('follows a show for Podcasts with its kind and queue switch; the Reader’s follow sets neither (#245)', () => {
    const { reader, api } = setup();
    api.push([]);
    const article = reader.addFeed('https://blog.example/feed', 'Design');
    expect(api.set.mock.lastCall![2]).not.toHaveProperty('kind');
    expect(api.set.mock.lastCall![2]).not.toHaveProperty('autoQueue');
    const show = reader.addFeed('https://pod.example/rss', 'Making', 'Kiln talk', {
      podcast: true,
    });
    expect(api.set.mock.lastCall![1]).toBe(`users/u1/feeds/${show}`);
    expect(api.set.mock.lastCall![2]).toMatchObject({
      url: 'https://pod.example/rss',
      title: 'Kiln talk',
      folders: ['Making'],
      kind: 'podcast',
      autoQueue: false,
    });
    reader.addFeed('https://queue.example/rss', undefined, 'Queued', {
      podcast: true,
      autoQueue: true,
    });
    expect(api.set.mock.lastCall![2]).toMatchObject({ kind: 'podcast', autoQueue: true });
    // The Reader's folders are its own feeds'; the shows are apart, by name.
    expect(reader.folderNames()).toEqual(['Design']);
    expect(reader.podcastFeeds().map((f) => f.title)).toEqual(['Kiln talk', 'Queued']);
    expect(reader.podcastFolderNames()).toEqual(['Making']);
    expect(reader.isPodcast(show!)).toBe(true);
    expect(reader.isPodcast(article!)).toBe(false);
  });

  it('moves a feed to Podcasts and back to the Reader, through the cache (#245)', () => {
    const { reader, api } = setup();
    api.push([{ id: 'a', data: { url: 'https://a.test/f', title: 'Alpha', folders: ['Games'] } }]);
    reader.setPodcast('a', true);
    expect(api.set.mock.lastCall).toEqual([
      {},
      'users/u1/feeds/a',
      { kind: 'podcast', updatedAt: 'SERVER_TIME' },
      true,
    ]);
    expect(reader.isPodcast('a')).toBe(true);
    expect(reader.folders()).toEqual([]);
    reader.setPodcast('a', false);
    expect(api.set.mock.lastCall![2]).toEqual({ kind: 'CLEAR', updatedAt: 'SERVER_TIME' });
    expect(reader.feeds()[0]).not.toHaveProperty('kind');
    expect(reader.folderNames()).toEqual(['Games']);
  });

  it('reads a feed’s artwork, web links only, and writes a show’s queue switch (#246)', () => {
    const { reader, api } = setup();
    const at = { toMillis: () => 1700 };
    api.push([
      {
        id: 'p',
        data: {
          url: 'https://p.test/f',
          title: 'Pod',
          folders: [],
          kind: 'podcast',
          image: 'https://p.test/show.jpg',
          lastItemAt: at,
        },
      },
      {
        id: 'q',
        data: { url: 'https://q.test/f', title: 'Q', folders: [], image: 'javascript:x' },
      },
    ]);
    expect(reader.feeds()[0]).toMatchObject({ image: 'https://p.test/show.jpg', lastItemAt: 1700 });
    expect(reader.feeds()[1]).not.toHaveProperty('image');
    reader.setAutoQueue('p', true);
    expect(api.set.mock.lastCall).toEqual([
      {},
      'users/u1/feeds/p',
      { autoQueue: true, updatedAt: 'SERVER_TIME' },
      true,
    ]);
    expect(reader.feeds()[0].autoQueue).toBe(true);
  });

  it('listens for Podcasts while the Reader is off (#245)', () => {
    const { api, modules } = setup();
    modules.set('reader', false);
    modules.set('podcasts', true);
    TestBed.tick();
    expect(api.listen).toHaveBeenCalledTimes(1);
    modules.set('podcasts', false);
    TestBed.tick();
    modules.set('podcasts', true);
    TestBed.tick();
    expect(api.listen).toHaveBeenCalledTimes(2);
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

describe('ReaderService.importFeedly (#176)', () => {
  const entry = (n: number, feed = 'https://kottke.org/main/index.xml') => ({
    id: `e${n}`,
    originId: `g${n}`,
    title: `Article ${n}`,
    alternate: [{ href: `https://a.test/${n}` }],
    origin: { streamId: `feed/${feed}` },
    published: 1_762_000_000_000 + n,
    tags: n === 1 ? [{ id: 'user/u1/tag/Pottery', label: 'Pottery' }] : [],
  });
  const file = (entries: unknown[]) =>
    Object.assign(new Blob([JSON.stringify(entries)]), { name: 'saved.json' });

  it('sends the saves in batches of a hundred, saying how far it is, then what came of it', async () => {
    const save = vi.fn((url: string) => `att-${url}`);
    const { reader, api } = setup({ save });
    api.push([]);
    reader.importOpml(OPML);
    api.set.mockClear();
    api.knownLinks.add('https://a.test/2');
    const lines: string[] = [];
    const entries = Array.from({ length: 230 }, (_, i) =>
      entry(i + 1, i % 2 ? 'https://unfollowed.test/feed' : undefined),
    );
    const said = await reader.importFeedly(file(entries), (l) => lines.push(l));
    expect(api.importFeedlySaves.mock.calls.map(([b]) => b.length)).toEqual([100, 100, 30]);
    expect(lines).toEqual([
      'Imported 0 of 230 saved articles…',
      'Imported 100 of 230 saved articles…',
      'Imported 200 of 230 saved articles…',
    ]);
    expect(said).toBe(
      `Imported 229 saved articles (1 already here); boards became tags. The newest ${SAVES_QUEUED} went to the reading queue.`,
    );
    // A followed feed's entry keeps its feed and guid; an unfollowed one's goes to the saves.
    const [first] = api.importFeedlySaves.mock.calls[0];
    expect(first[0]).toMatchObject({
      url: 'https://a.test/1',
      feedUrl: 'https://kottke.org/main/index.xml',
      guid: 'g1',
      tags: ['Pottery'],
    });
    expect(first[1]).not.toHaveProperty('feedUrl');
    expect(first[1]).not.toHaveProperty('guid');
    // The newest fifty added, into the reading queue and tied to their articles.
    expect(save).toHaveBeenCalledTimes(SAVES_QUEUED);
    expect(save.mock.calls[0][0]).toBe('https://a.test/230');
    expect(api.set).toHaveBeenCalledTimes(SAVES_QUEUED);
    expect(api.set.mock.calls[0].slice(1)).toEqual([
      'users/u1/feedItems/i-https://a.test/230',
      { attachmentId: 'att-https://a.test/230', updatedAt: 'SERVER_TIME' },
      true,
    ]);
  });

  it('stops at the day’s cap with the server’s words, keeping what came', async () => {
    const { reader, api } = setup({ save: () => 'a' });
    api.push([]);
    api.importFeedlySaves.mockRejectedValueOnce(
      new Error(
        'Today’s 5000 imported articles are used up; import the same file tomorrow for the rest. [429]',
      ),
    );
    const entries = Array.from({ length: 3 }, (_, i) => entry(i + 1));
    expect(await reader.importFeedly(file(entries), () => undefined)).toBe(
      'Imported 0 saved articles (0 already here, 3 not yet); boards became tags. Today’s 5000 imported articles are used up; import the same file tomorrow for the rest.',
    );
  });

  it('waits for the feeds to be read when the file comes first, rather than refuse', async () => {
    const { reader, api } = setup({ save: () => 'a' });
    const said = reader.importFeedly(file([entry(1)]), () => undefined);
    TestBed.tick();
    api.push([]);
    TestBed.tick();
    expect(await said).toMatch(/^Imported 1 saved article \(0 already here\)/);
  });

  it('says how many files were too large, after what came of the rest (review on #199)', async () => {
    const { reader, api } = setup({ save: () => 'a' });
    api.push([]);
    const json = JSON.stringify([entry(1)]);
    const zip = await zipOf({ 'saved.json': json, 'a.json': json, 'b.json': json }, false, {
      'a.json': 65 * 1024 * 1024,
      'b.json': 65 * 1024 * 1024,
    });
    expect(await reader.importFeedly(zip, () => undefined)).toMatch(
      /^Imported 1 saved article .* 2 files too large were skipped\.$/,
    );
  });

  it('says so when a file holds nothing it can use', async () => {
    const { reader, api } = setup();
    api.push([]);
    const empty = Object.assign(new Blob(['{"id":"u1"}']), { name: 'profile.json' });
    expect(await reader.importFeedly(empty, () => undefined)).toMatch(
      /^No feeds or saved articles/,
    );
    expect(api.importFeedlySaves).not.toHaveBeenCalled();
  });
});
