import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW, SESSION_STORAGE, STORAGE } from '../platform/platform';
import { ReadingService } from '../reading/reading.service';
import {
  FakeItemsApi,
  FakeModules,
  FakeNotes,
  FakeReaderApi,
  FakeSettingsApi,
  fakeFirebase,
} from '../testing/fakes';
import { SETTINGS_API } from '../theme/theme-sync.service';
import { QUEUE_MAX } from '@mossgoblin/schema';
import {
  ALL,
  ITEMS_API,
  ItemsService,
  QUEUE_FULL,
  SAVED,
  SPLIT_KEY,
  VISITED_KEY,
} from './items.service';
import { READER_API } from './reader.service';

const NOW_MS = Date.parse('2026-11-07T12:00:00Z');
const H = 3_600_000;
const stamp = (ms: number) => ({ toMillis: () => ms });

const item = (
  id: string,
  feedId: string,
  hoursAgo: number,
  more: Record<string, unknown> = {},
) => ({
  id,
  data: {
    feedId,
    title: `Article ${id}`,
    link: `https://x.test/${id}`,
    published: stamp(NOW_MS - hoursAgo * H),
    summary: 'First words',
    content: 'First words and more',
    read: false,
    saved: false,
    ...more,
  },
});

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

function setup(session: Storage | null = memoryStorage(), local: Storage | null = memoryStorage()) {
  const api = new FakeItemsApi();
  const feeds = new FakeReaderApi();
  const modules = new FakeModules();
  modules.set('reader', true);
  const notes = new FakeNotes();
  const reading = { save: vi.fn((_url: string) => 'att1') };
  const user = signal<User | null | undefined>({ uid: 'u1' } as User);
  const settings = new FakeSettingsApi();
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: ITEMS_API, useValue: api },
      { provide: NotesService, useValue: notes },
      { provide: ReadingService, useValue: reading },
      { provide: READER_API, useValue: feeds },
      { provide: SETTINGS_API, useValue: settings },
      { provide: ModulesService, useValue: modules },
      { provide: AuthService, useValue: { user } },
      { provide: NOW, useValue: () => NOW_MS },
      { provide: SESSION_STORAGE, useValue: session },
      { provide: STORAGE, useValue: local },
    ],
  });
  const items = TestBed.inject(ItemsService);
  TestBed.tick();
  feeds.push([
    { id: 'f1', data: { url: 'https://a.test/f', title: 'Design blog', folders: ['Design'] } },
    { id: 'f2', data: { url: 'https://b.test/f', title: 'Dice', folders: ['Games', 'Design'] } },
    { id: 'f3', data: { url: 'https://c.test/f', title: 'Loose', folders: [] } },
  ]);
  return { items, api, feeds, user, modules, notes, reading, settings, local };
}

describe('ItemsService (#162)', () => {
  it('listens to three shelves and counts the unread per folder, feeds in two folders in both', () => {
    const { items, api } = setup();
    expect(api.listen.mock.calls.map((c) => c[2])).toEqual(['unread', 'read', 'saved']);
    expect(items.loaded()).toBe(false);
    api.push('unread', [item('a', 'f1', 1), item('b', 'f2', 2), item('c', 'f3', 3)]);
    api.push('saved', [item('s', 'f1', 30, { saved: true, read: true })]);
    api.push('read', [
      item('r', 'f2', 5, { read: true }),
      item('s', 'f1', 30, { saved: true, read: true }),
    ]);
    expect(items.loaded()).toBe(true);
    expect(items.unreadCounts()).toEqual({
      [ALL]: 3,
      [SAVED]: 0,
      Design: 2,
      Games: 1,
      Uncategorized: 1,
    });
    expect(items.items().map((i) => i.id)).toEqual(['a', 'b', 'c', 'r', 's']);
  });

  it('opens an article no shelf holds, one a search found, without counting it (#175)', () => {
    const { items, api } = setup();
    api.push('unread', [item('a', 'f1', 1)]);
    items.open('a');
    expect(api.listenOne).not.toHaveBeenCalled();
    expect(items.find('old')).toBeUndefined();
    items.open('old');
    items.open('old');
    expect(api.listenOne).toHaveBeenCalledTimes(1);
    expect(api.listenOne.mock.calls[0][1]).toBe('users/u1/feedItems/old');
    api.pushOne('users/u1/feedItems/old', item('old', 'f1', 9000, { read: true }).data);
    expect(items.find('old')?.title).toBe('Article old');
    expect(items.unreadCounts()[ALL]).toBe(1);
    expect(items.inShelf({ kind: 'folder', name: ALL }, true).map((i) => i.id)).toEqual(['a']);
    // A mark shows at once; the document's echo takes over.
    items.setRead('old', false);
    expect(items.find('old')?.read).toBe(false);
    api.pushOne('users/u1/feedItems/old', item('old', 'f1', 9000, { read: false }).data);
    expect(items.find('old')?.read).toBe(false);
    api.pushOne('users/u1/feedItems/old', undefined);
    expect(items.find('old')).toBeUndefined();
  });

  it('shows a shelf: a folder, All, Saved, one feed, read ones only when asked', () => {
    const { items, api } = setup();
    api.push('unread', [item('a', 'f1', 1), item('b', 'f2', 2), item('c', 'f3', 3)]);
    api.push('read', [item('r', 'f2', 5, { read: true })]);
    api.push('saved', [item('s', 'f1', 30, { saved: true, read: true })]);
    const ids = (list: { id: string }[]) => list.map((i) => i.id);
    expect(ids(items.inShelf({ kind: 'folder', name: 'Design' }, false))).toEqual(['a', 'b']);
    expect(ids(items.inShelf({ kind: 'folder', name: 'Design' }, true))).toEqual([
      'a',
      'b',
      'r',
      's',
    ]);
    expect(ids(items.inShelf({ kind: 'folder', name: 'Uncategorized' }, false))).toEqual(['c']);
    expect(ids(items.inShelf({ kind: 'folder', name: ALL }, false))).toEqual(['a', 'b', 'c']);
    expect(ids(items.inShelf({ kind: 'folder', name: SAVED }, false))).toEqual(['s']);
    expect(ids(items.inShelf({ kind: 'feed', id: 'f2' }, true))).toEqual(['b', 'r']);
    expect(items.find('r')?.read).toBe(true);
  });

  it('keeps a show in Podcasts out of every shelf, count and line of the Reader’s (#245)', () => {
    const { items, api, feeds } = setup();
    feeds.push([
      { id: 'f1', data: { url: 'https://a.test/f', title: 'Design blog', folders: ['Design'] } },
      {
        id: 'p1',
        data: {
          url: 'https://pod.test/f',
          title: 'Kiln hour',
          folders: ['Design'],
          kind: 'podcast',
        },
      },
      { id: 'p2', data: { url: 'https://odd.test/f', title: 'Odd', folders: [], kind: 'video' } },
    ]);
    const audio = { url: 'https://pod.test/1.mp3', type: 'audio/mpeg', bytes: 10, seconds: 2530 };
    api.push('unread', [
      item('a', 'f1', 1),
      item('e2', 'p1', 2, { enclosure: audio, image: 'https://pod.test/1.jpg', episode: 2 }),
      item('e1', 'p1', 50, { enclosure: { url: 'javascript:x', type: 'audio/mpeg' } }),
      item('o', 'p2', 3),
    ]);
    api.push('read', [item('e0', 'p1', 90, { read: true, saved: true })]);
    const ids = (list: { id: string }[]) => list.map((i) => i.id);
    // No shelf of the Reader's holds an episode, Saved and a show's own shelf included.
    expect(ids(items.inShelf({ kind: 'folder', name: ALL }, true))).toEqual(['a', 'o']);
    expect(ids(items.inShelf({ kind: 'folder', name: 'Design' }, true))).toEqual(['a']);
    expect(ids(items.inShelf({ kind: 'folder', name: SAVED }, true))).toEqual([]);
    expect(ids(items.inShelf({ kind: 'feed', id: 'p1' }, true))).toEqual([]);
    expect(items.unreadCounts()).toEqual({ [ALL]: 2, [SAVED]: 0, Design: 1, Uncategorized: 1 });
    expect(items.newSince()).toEqual([
      { folder: 'Design', count: 1 },
      { folder: 'Uncategorized', count: 1 },
    ]);
    // Podcasts has them, newest first, read or not.
    expect(ids(items.episodes())).toEqual(['e2', 'e1', 'e0']);
    expect(items.find('e2')).toMatchObject({
      enclosure: audio,
      image: 'https://pod.test/1.jpg',
      episode: 2,
    });
    // What is no web link is no audio; an article has none.
    expect(items.find('e1')).not.toHaveProperty('enclosure');
    expect(items.find('a')).not.toHaveProperty('enclosure');
  });

  it('listens to each show’s newest episodes, read or not, as shows come and go (#245)', () => {
    const { items, api, feeds } = setup();
    const pod = (id: string) => ({
      id,
      data: { url: `https://${id}.test/f`, title: id, folders: [], kind: 'podcast' },
    });
    feeds.push([pod('p1'), pod('p2')]);
    TestBed.tick();
    expect(api.listenFeed.mock.calls.map((c) => c[2])).toEqual(['p1', 'p2']);
    expect(api.listenFeed.mock.calls[0][1]).toBe('users/u1/feedItems');
    // An episode whose notes were read long ago, past the two hundred read at hand.
    api.pushFeed('p1', [item('old', 'p1', 900, { read: true })]);
    expect(items.episodes().map((e) => e.id)).toEqual(['old']);
    // The same list again starts nothing; a show moved to the Reader is let go.
    feeds.push([pod('p1'), pod('p2')]);
    TestBed.tick();
    expect(api.listenFeed).toHaveBeenCalledTimes(2);
    feeds.push([
      pod('p1'),
      { id: 'p2', data: { url: 'https://p2.test/f', title: 'p2', folders: [] } },
    ]);
    TestBed.tick();
    expect(api.stopFeed).toHaveBeenCalledWith('p2');
    expect(api.listenFeed).toHaveBeenCalledTimes(2);
    // Signed out: every one stops, and nothing is kept.
    TestBed.inject(AuthService).user.set(null);
    TestBed.tick();
    expect(api.stopFeed).toHaveBeenCalledWith('p1');
    expect(items.episodes()).toEqual([]);
  });

  it('marks an episode heard, or new again, and leaves its notes read as they are (#245)', () => {
    const { items, api, feeds } = setup();
    feeds.push([
      { id: 'p1', data: { url: 'https://p.test/f', title: 'Pod', folders: [], kind: 'podcast' } },
    ]);
    TestBed.tick();
    api.pushFeed('p1', [item('e1', 'p1', 1, { read: true, position: 300 })]);
    items.setPlayed('e1', true);
    expect(items.find('e1')).toMatchObject({ played: true, read: true });
    expect(api.set).toHaveBeenLastCalledWith(expect.anything(), 'users/u1/feedItems/e1', {
      played: true,
      updatedAt: 'SERVER_TIME',
    });
    items.setPlayed('e1', false);
    expect(items.find('e1')?.played).toBe(false);
    expect(items.find('e1')?.position).toBeUndefined();
    expect(api.set).toHaveBeenLastCalledWith(expect.anything(), 'users/u1/feedItems/e1', {
      played: false,
      position: 'CLEAR',
      updatedAt: 'SERVER_TIME',
    });
  });

  it('loads a show’s older episodes on demand, a page at a time, and marks many heard (#246)', async () => {
    const { items, api, feeds } = setup();
    feeds.push([
      { id: 'p1', data: { url: 'https://p.test/f', title: 'Pod', folders: [], kind: 'podcast' } },
    ]);
    TestBed.tick();
    // Fewer than a hundred: nothing older to look for.
    api.pushFeed('p1', [item('e1', 'p1', 1)]);
    expect(items.mayHaveOlder('p1')).toBe(false);
    // A full hundred: there may be more, the next page asked for before the oldest.
    const hundred = Array.from({ length: 100 }, (_, n) => item(`e${n}`, 'p1', n + 1));
    api.pushFeed('p1', hundred);
    expect(items.mayHaveOlder('p1')).toBe(true);
    // The page starts at the oldest at hand, so it comes back too and
    // is dropped: episodes sharing its instant are not cut (#250).
    api.pageFeed.mockResolvedValueOnce([
      item('e99', 'p1', 100),
      item('old1', 'p1', 200),
      item('old2', 'p1', 300),
    ]);
    expect(await items.loadOlder('p1')).toBe(2);
    expect(api.pageFeed).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/feedItems',
      'p1',
      NOW_MS - 100 * H,
      101,
    );
    expect(items.olderEpisodes('p1').map((e) => e.id)).toEqual(['old1', 'old2']);
    // A short page: that was the last; the older ones open like any other.
    expect(items.mayHaveOlder('p1')).toBe(false);
    expect(items.find('old2')?.title).toBe('Article old2');
    // Not in the listened episodes, so the counts stay the newest hundred's.
    expect(items.episodes()).toHaveLength(100);
    // Mark all as heard: one batch, shown at once, older ones included.
    expect(items.setPlayedMany(['e0', 'old1'])).toBe(2);
    expect(items.find('old1')?.played).toBe(true);
    expect(api.setMany).toHaveBeenLastCalledWith(expect.anything(), [
      { path: 'users/u1/feedItems/e0', data: { played: true, updatedAt: 'SERVER_TIME' } },
      { path: 'users/u1/feedItems/old1', data: { played: true, updatedAt: 'SERVER_TIME' } },
    ]);
    // Offline with nothing cached: said, and nothing lost.
    api.pageFeed.mockRejectedValueOnce(new Error('unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await items.loadOlder('p1')).toMatch(/Could not load older episodes/);
    // The show moved to the Reader: its older pages go.
    feeds.push([{ id: 'p1', data: { url: 'https://p.test/f', title: 'Pod', folders: [] } }]);
    TestBed.tick();
    expect(items.olderEpisodes('p1')).toEqual([]);
  });

  it('keeps where an episode was left, lists the ones part-way, and marks one heard (#179)', () => {
    const { items, api } = setup();
    const audio = { url: 'https://pod.test/1.mp3', type: 'audio/mpeg', seconds: 2530 };
    api.push('unread', [
      item('a', 'f1', 1),
      item('e1', 'f3', 2, { enclosure: audio, position: 754.5, playedAt: stamp(NOW_MS - H) }),
      item('e2', 'f3', 3, { enclosure: audio, position: 60, playedAt: stamp(NOW_MS) }),
      item('e3', 'f3', 4, { enclosure: audio, position: 0 }),
      item('e4', 'f3', 5, { enclosure: audio, position: '12:34' }),
    ]);
    api.push('read', [
      item('e5', 'f3', 6, {
        enclosure: audio,
        position: 2530,
        played: true,
        read: true,
        playedAt: stamp(NOW_MS),
      }),
    ]);
    expect(items.find('e1')).toMatchObject({ position: 754.5, playedAt: NOW_MS - H });
    expect(items.find('e4')).not.toHaveProperty('position');
    expect(items.find('e5')?.played).toBe(true);
    // Part-way and not heard to the end, the latest played first.
    expect(items.listening().map((i) => i.id)).toEqual(['e2', 'e1']);

    // When is the device's clock at the write, and returned (Eric, 2026-11-07).
    expect(items.setProgress('e1', { position: 800 })).toBe(NOW_MS);
    expect(api.set.mock.lastCall).toEqual([
      {},
      'users/u1/feedItems/e1',
      { position: 800, playedAt: `TIME:${NOW_MS}`, played: false, updatedAt: 'SERVER_TIME' },
    ]);
    // Heard to the end: the marks in a merge without playedAt, so a
    // refused place (#190) never loses them, then the place.
    const before = api.set.mock.calls.length;
    items.setProgress('e2', { position: 2530, played: true });
    expect(api.set.mock.calls.slice(before).map((c) => c.slice(1))).toEqual([
      [
        'users/u1/feedItems/e2',
        { played: true, read: true, readAt: 'SERVER_TIME', updatedAt: 'SERVER_TIME' },
      ],
      [
        'users/u1/feedItems/e2',
        { position: 2530, playedAt: `TIME:${NOW_MS}`, updatedAt: 'SERVER_TIME' },
      ],
    ]);
    expect(items.find('e2')?.read).toBe(true);
    expect(items.clock(754.5)).toBe('12:34');
    expect(items.clock(3725)).toBe('1:02:05');
    expect(items.clock(NaN)).toBe('0:00');
  });

  it('says how long an episode is (#178)', () => {
    const { items } = setup();
    expect(items.duration(2530)).toBe('42 min');
    expect(items.duration(3900)).toBe('1 h 05 min');
    expect(items.duration(7200)).toBe('2 h');
    expect(items.duration(10)).toBe('1 min');
    expect(items.duration(0)).toBe('1 min');
  });

  it('marks read and saved at once, and the echo takes over from the local mark', () => {
    const { items, api } = setup();
    api.push('unread', [item('a', 'f1', 1), item('b', 'f2', 2)]);
    items.setRead('a', true);
    expect(items.find('a')?.read).toBe(true);
    expect(items.unreadCounts()[ALL]).toBe(1);
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/feedItems/a',
      { read: true, readAt: 'SERVER_TIME', updatedAt: 'SERVER_TIME' },
    ]);
    items.setRead('a', false);
    expect(api.set.mock.lastCall![2]).toEqual({
      read: false,
      readAt: 'CLEAR',
      updatedAt: 'SERVER_TIME',
    });
    items.setSaved('b', true);
    expect(items.find('b')?.saved).toBe(true);
    expect(api.set.mock.lastCall![2]).toEqual({
      saved: true,
      attachmentId: 'att1',
      expireAt: 'CLEAR',
      updatedAt: 'SERVER_TIME',
    });
    // The listener's echo carries the mark; the local copy goes.
    api.push('unread', [item('a', 'f1', 1), item('b', 'f2', 2, { saved: true })]);
    expect(items.find('b')?.saved).toBe(true);
  });

  it('saving puts the link in the reading queue once; unsaving leaves it', () => {
    const { items, api, reading } = setup();
    api.push('unread', [item('a', 'f1', 1), item('b', 'f2', 2, { attachmentId: 'old' })]);
    items.setSaved('a', true);
    expect(reading.save).toHaveBeenCalledWith('https://x.test/a');
    expect(items.find('a')?.attachmentId).toBe('att1');
    items.setSaved('a', false);
    expect(api.set.mock.lastCall![2]).toEqual({ saved: false, updatedAt: 'SERVER_TIME' });
    items.setSaved('b', true);
    expect(reading.save).toHaveBeenCalledTimes(1);
  });

  it('files an article in the garden as a clipping, once, and asks for reader mode', async () => {
    const { items, api, notes } = setup();
    api.push('unread', [item('a', 'f1', 1, { author: 'Ann', content: 'Words *here*' })]);
    const noteId = items.fileInGarden('a');
    expect(noteId).toBe('clip1');
    expect(notes.clip).toHaveBeenCalledWith(
      '_From [Design blog](https://x.test/a), by Ann, 2026-11-07._\n\nWords *here*',
      'Article a',
      { url: 'https://x.test/a', feedItemId: 'a' },
    );
    expect(api.set.mock.lastCall!.slice(1)).toEqual([
      'users/u1/feedItems/a',
      { noteId: 'clip1', expireAt: 'CLEAR', updatedAt: 'SERVER_TIME' },
    ]);
    expect(items.fileInGarden('a')).toBe('clip1');
    expect(notes.clip).toHaveBeenCalledTimes(1);
    expect(await items.readerMode('a')).toBeUndefined();
    expect(api.fetchArticle).toHaveBeenCalledWith('a');
    api.fetchArticle.mockRejectedValueOnce(
      new Error('Could not fetch the page: the page is not HTML'),
    );
    expect(await items.readerMode('a')).toBe('Could not fetch the page: the page is not HTML');
    api.fetchArticle.mockRejectedValueOnce(new Error('internal'));
    expect(await items.readerMode('a')).toBe('Could not fetch the page. Are you online?');
  });

  it('marks all read on a shelf in one batch, what is at hand', () => {
    const { items, api } = setup();
    api.push('unread', [item('a', 'f1', 1), item('b', 'f2', 2), item('c', 'f3', 3)]);
    expect(items.markAllRead({ kind: 'folder', name: 'Design' })).toBe(2);
    expect(api.setMany.mock.calls[0][1].map((w) => w.path)).toEqual([
      'users/u1/feedItems/a',
      'users/u1/feedItems/b',
    ]);
    expect(items.unreadCounts()[ALL]).toBe(1);
    expect(items.markAllRead({ kind: 'folder', name: 'Design' })).toBe(0);
    // Saved shows read ones too; they are not marked again (review on #167).
    api.push('saved', [
      item('s1', 'f1', 10, { saved: true, read: true }),
      item('s2', 'f1', 11, { saved: true }),
    ]);
    expect(items.markAllRead({ kind: 'folder', name: SAVED })).toBe(1);
    expect(api.setMany.mock.lastCall![1].map((w) => w.path)).toEqual(['users/u1/feedItems/s2']);
  });

  it('marks several read or unread in one batch, at once (#172)', () => {
    const { items, api } = setup();
    api.push('unread', [item('a', 'f1', 1), item('b', 'f2', 2), item('c', 'f3', 3)]);
    expect(items.setReadMany(['a', 'b'], true)).toBe(2);
    expect(items.unreadCounts()[ALL]).toBe(1);
    expect(items.find('a')?.read).toBe(true);
    expect(api.setMany).toHaveBeenCalledTimes(1);
    expect(api.setMany.mock.lastCall![1]).toEqual([
      {
        path: 'users/u1/feedItems/a',
        data: { read: true, readAt: 'SERVER_TIME', updatedAt: 'SERVER_TIME' },
      },
      {
        path: 'users/u1/feedItems/b',
        data: { read: true, readAt: 'SERVER_TIME', updatedAt: 'SERVER_TIME' },
      },
    ]);
    expect(items.setReadMany(['a', 'b'], false)).toBe(2);
    expect(items.unreadCounts()[ALL]).toBe(3);
    expect(api.setMany.mock.lastCall![1][0].data).toEqual({
      read: false,
      readAt: 'CLEAR',
      updatedAt: 'SERVER_TIME',
    });
    expect(items.setReadMany([], true)).toBe(0);
    expect(api.setMany).toHaveBeenCalledTimes(2);
  });

  it('counts what is new per folder since its list was opened, and notes it seen (#173)', () => {
    const { items, api, settings } = setup();
    settings.push({
      folderOrder: [],
      images: true,
      seenAt: { Design: NOW_MS - 2.5 * H },
      updatedAt: 1,
    });
    api.push('unread', [
      item('a', 'f1', 1),
      item('b', 'f2', 2),
      item('c', 'f1', 3),
      item('d', 'f3', 4),
      item('e', 'f2', 5),
      item('r', 'f2', 0.5, { read: true }),
    ]);
    // Design was seen between b and c; Games and Uncategorized never were.
    expect(items.newSince()).toEqual([
      { folder: 'Design', count: 2 },
      { folder: 'Games', count: 2 },
      { folder: 'Uncategorized', count: 1 },
    ]);
    items.markSeen('Games');
    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set.mock.lastCall![2]['seenAt']).toEqual({
      Design: NOW_MS - 2.5 * H,
      Games: NOW_MS,
    });
    expect(items.newSince()).toEqual([
      { folder: 'Design', count: 2 },
      { folder: 'Uncategorized', count: 1 },
    ]);
    // Nothing newer since: no write.
    items.markSeen('Games');
    expect(settings.set).toHaveBeenCalledTimes(1);
    // A folder with nothing unread is not written either.
    items.markSeen('Apple');
    expect(settings.set).toHaveBeenCalledTimes(1);
    // One dated ahead of this clock is seen too.
    api.push('unread', [item('z', 'f3', -2)]);
    items.markSeen('Uncategorized');
    expect(
      (settings.set.mock.lastCall![2]['seenAt'] as Record<string, number>)['Uncategorized'],
    ).toBe(NOW_MS + 2 * H);
    expect(items.newSince()).toEqual([]);
  });

  it('says how old an article is, in words', () => {
    const { items } = setup();
    expect(items.age(NOW_MS - 30_000)).toBe('just now');
    expect(items.age(NOW_MS - 5 * 60_000)).toBe('5 min ago');
    expect(items.age(NOW_MS - 3 * H)).toBe('3 h ago');
    expect(items.age(NOW_MS - 26 * H)).toBe('yesterday');
    expect(items.age(NOW_MS - 3 * 24 * H)).toBe('3 days ago');
    expect(items.age(NOW_MS - 30 * 24 * H)).toMatch(/Oct/);
  });

  it('keeps the articles opened on a shelf; another shelf, or signing out, starts afresh (#188)', () => {
    const session = memoryStorage();
    const { items, user } = setup(session);
    const design = { kind: 'folder', name: 'Design' } as const;
    const feed = { kind: 'feed', id: 'f1' } as const;
    expect([...items.visitedIn(design)]).toEqual([]);
    items.visit(design, 'a');
    items.visit(design, 'b');
    items.visit(design, 'a');
    expect([...items.visitedIn(design)]).toEqual(['a', 'b']);
    expect([...items.visitedIn({ kind: 'folder', name: 'Design' })]).toEqual(['a', 'b']);
    // Asking after another shelf changes nothing; opening one on it does.
    expect([...items.visitedIn(feed)]).toEqual([]);
    expect([...items.visitedIn(design)]).toEqual(['a', 'b']);
    items.visit(feed, 'c');
    expect([...items.visitedIn(feed)]).toEqual(['c']);
    expect([...items.visitedIn(design)]).toEqual([]);
    items.visit(design, 'a');
    expect([...items.visitedIn(design)]).toEqual(['a']);
    user.set(null);
    TestBed.tick();
    expect([...items.visitedIn(design)]).toEqual([]);
    expect(session.getItem(VISITED_KEY)).toBeNull();
  });

  it("keeps them in this tab's storage, so a fresh service after a reload has them (#188)", () => {
    const session = memoryStorage();
    const design = { kind: 'folder', name: 'Design' } as const;
    const first = setup(session).items;
    first.visit(design, 'a');
    first.visit(design, 'b');
    expect(JSON.parse(session.getItem(VISITED_KEY)!)).toEqual({
      shelf: 'f:Design',
      ids: ['a', 'b'],
    });
    TestBed.resetTestingModule();
    const { items } = setup(session);
    expect([...items.visitedIn(design)]).toEqual(['a', 'b']);
    expect([...items.visitedIn({ kind: 'feed', id: 'f1' })]).toEqual([]);
  });

  it('carries on without storage, or with storage that throws or holds junk (#188)', () => {
    const design = { kind: 'folder', name: 'Design' } as const;
    const none = setup(null).items;
    none.visit(design, 'a');
    expect([...none.visitedIn(design)]).toEqual(['a']);
    TestBed.resetTestingModule();
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const { items, user } = setup(throwing);
    items.visit(design, 'a');
    expect([...items.visitedIn(design)]).toEqual(['a']);
    user.set(null);
    TestBed.tick();
    expect([...items.visitedIn(design)]).toEqual([]);
    TestBed.resetTestingModule();
    const junk = memoryStorage();
    junk.setItem(VISITED_KEY, '{not json');
    expect([...setup(junk).items.visitedIn(design)]).toEqual([]);
  });

  it('listens to nothing while the module is off', () => {
    const { api, modules } = setup();
    modules.set('reader', false);
    TestBed.tick();
    expect(api.listen).toHaveBeenCalledTimes(3);
  });
});

describe('the listening queue (#249)', () => {
  const audio = { enclosure: { url: 'https://p.test/a.mp3', type: 'audio/mpeg', seconds: 600 } };
  const episode = (id: string, more: Record<string, unknown> = {}) =>
    item(id, 'p1', 1, { ...audio, ...more });

  function queueSetup() {
    const s = setup();
    s.feeds.push([
      { id: 'p1', data: { url: 'https://p.test/f', title: 'Pod', folders: [], kind: 'podcast' } },
      { id: 'f1', data: { url: 'https://a.test/f', title: 'Design blog', folders: [] } },
    ]);
    TestBed.tick();
    /** The queue's writes, one place each, in order. */
    const places = () =>
      s.api.set.mock.calls
        .filter((c) => 'queue' in c[2])
        .map((c) => [c[1].split('/').at(-1), c[2]['queue']]);
    return { ...s, places };
  }

  it('listens to the queued items, ascending, the shows’ in Podcasts only', () => {
    const { items, api } = queueSetup();
    expect(api.listenQueue).toHaveBeenCalledTimes(1);
    expect(api.listenQueue.mock.calls[0][1]).toBe('users/u1/feedItems');
    api.pushQueue([
      episode('b', { queue: 2000 }),
      episode('a', { queue: 1000 }),
      episode('tie', { queue: 2000 }),
      // A Reader feed's item, its show moved: not the queue's.
      item('reader', 'f1', 1, { ...audio, queue: 500 }),
      // A place that is no number.
      episode('junk', { queue: 'first' }),
    ]);
    expect(items.queue().map((i) => i.id)).toEqual(['a', 'b', 'tie']);
    expect(items.queued('b')).toBe(true);
    expect(items.queued('reader')).toBe(false);
    expect(items.readerItems().map((i) => i.id)).not.toContain('reader');
    // Older than the show's newest hundred, and read: still in the queue.
    expect(items.find('a')?.queue).toBe(1000);
  });

  it('moves a show to the Reader with its episodes off the queue, in one batch (#251)', () => {
    const { items, api, feeds } = queueSetup();
    feeds.push([
      { id: 'p1', data: { url: 'https://p.test/f', title: 'Pod', folders: [], kind: 'podcast' } },
      { id: 'p2', data: { url: 'https://q.test/f', title: 'Other', folders: [], kind: 'podcast' } },
    ]);
    TestBed.tick();
    api.pushQueue([
      episode('a', { queue: 1000 }),
      item('other', 'p2', 1, { ...audio, queue: 1500 }),
      episode('b', { queue: 2000 }),
    ]);
    expect(items.moveToReader('p1')).toBe(2);
    expect(api.setMany).toHaveBeenCalledTimes(1);
    expect(api.setMany.mock.calls[0][1]).toEqual([
      { path: 'users/u1/feeds/p1', data: { kind: 'CLEAR', updatedAt: 'SERVER_TIME' } },
      { path: 'users/u1/feedItems/a', data: { queue: 'CLEAR', updatedAt: 'SERVER_TIME' } },
      { path: 'users/u1/feedItems/b', data: { queue: 'CLEAR', updatedAt: 'SERVER_TIME' } },
    ]);
    expect(items.queue().map((i) => i.id)).toEqual(['other']);
    // Nothing queued: the move alone, still one batch.
    expect(items.moveToReader('p2')).toBe(1);
    expect(items.moveToReader('p2')).toBe(0);
    expect(api.setMany.mock.calls.at(-1)![1]).toEqual([
      { path: 'users/u1/feeds/p2', data: { kind: 'CLEAR', updatedAt: 'SERVER_TIME' } },
    ]);
  });

  it('leaves out a queued episode whose show is gone (#251)', () => {
    const { items, api, feeds } = queueSetup();
    api.pushQueue([episode('a', { queue: 1000 }), item('gone', 'p9', 1, { ...audio, queue: 500 })]);
    expect(items.queue().map((i) => i.id)).toEqual(['a']);
    feeds.push([]);
    TestBed.tick();
    expect(items.queue()).toEqual([]);
    expect(items.find('gone')).toBeUndefined();
  });

  it('clears the keep-for expiry in the same write as a place, never on taking one off (review on #252)', () => {
    const { items, api } = queueSetup();
    api.pushFeed('p1', [episode('a'), episode('b')]);
    items.addToQueue('a');
    expect(api.set.mock.calls.at(-1)![2]).toEqual({
      queue: NOW_MS,
      expireAt: 'CLEAR',
      updatedAt: 'SERVER_TIME',
    });
    items.playNext('b');
    expect(api.set.mock.calls.at(-1)![2]).toEqual({
      queue: NOW_MS - 1000,
      expireAt: 'CLEAR',
      updatedAt: 'SERVER_TIME',
    });
    // Off again: no expiry put back, as unsaving puts none back.
    items.removeFromQueue('a');
    expect(api.set.mock.calls.at(-1)![2]).toEqual({ queue: 'CLEAR', updatedAt: 'SERVER_TIME' });
  });

  it('refuses a new episode past the queue’s cap, and still moves one in it (review on #252)', () => {
    const { items, api } = queueSetup();
    api.pushQueue(
      Array.from({ length: QUEUE_MAX }, (_, n) => episode(`q${n}`, { queue: n * 1000 })),
    );
    api.pushFeed('p1', [episode('new')]);
    const writes = api.set.mock.calls.length;
    expect(items.addToQueue('new')).toBe(QUEUE_FULL);
    expect(items.playNext('new')).toBe(QUEUE_FULL);
    expect(QUEUE_FULL).toBe('The queue is full: 500 episodes. Take some off to add more.');
    expect(api.set.mock.calls.length).toBe(writes);
    expect(items.queued('new')).toBe(false);
    // One already in the queue moves to the front.
    expect(items.playNext('q9')).toBeUndefined();
    expect(items.queue()[0].id).toBe('q9');
    // A place freed, a new one fits.
    items.removeFromQueue('q1');
    api.pushQueue(
      Array.from({ length: QUEUE_MAX }, (_, n) => episode(`q${n}`, { queue: n * 1000 })).filter(
        (d) => d.id !== 'q1',
      ),
    );
    expect(items.addToQueue('new')).toBeUndefined();
    expect(items.queued('new')).toBe(true);
  });

  it('adds at the end, never before now, plays next a step before the first, and removes', () => {
    const { items, api, places } = queueSetup();
    api.pushFeed('p1', [episode('a'), episode('b'), episode('c')]);
    items.addToQueue('a');
    expect(places()).toEqual([['a', NOW_MS]]);
    expect(items.queue().map((i) => i.id)).toEqual(['a']);
    items.addToQueue('b');
    items.addToQueue('b');
    expect(places().at(-1)).toEqual(['b', NOW_MS + 1000]);
    expect(places()).toHaveLength(2);
    items.playNext('c');
    expect(places().at(-1)).toEqual(['c', NOW_MS - 1000]);
    expect(items.queue().map((i) => i.id)).toEqual(['c', 'a', 'b']);
    items.removeFromQueue('a');
    expect(places().at(-1)).toEqual(['a', 'CLEAR']);
    expect(items.queue().map((i) => i.id)).toEqual(['c', 'b']);
    expect(api.set.mock.calls.at(-1)![2]).toEqual({ queue: 'CLEAR', updatedAt: 'SERVER_TIME' });
  });

  it('moves to the midpoint of its new neighbours, or past an end', () => {
    const { items, api, places } = queueSetup();
    api.pushQueue([
      episode('a', { queue: 1000 }),
      episode('b', { queue: 2000 }),
      episode('c', { queue: 3000 }),
    ]);
    items.moveInQueue('c', ['a', 'c', 'b']);
    expect(places().at(-1)).toEqual(['c', 1500]);
    expect(items.queue().map((i) => i.id)).toEqual(['a', 'c', 'b']);
    items.moveInQueue('b', ['b', 'a', 'c']);
    expect(places().at(-1)).toEqual(['b', 0]);
    items.moveInQueue('b', ['a', 'c', 'b']);
    expect(places().at(-1)).toEqual(['b', NOW_MS]);
    expect(api.setMany).not.toHaveBeenCalled();
  });

  it('renumbers the whole queue in one batch when neighbours are too close', () => {
    const { items, api } = queueSetup();
    api.pushQueue([
      episode('a', { queue: 1000 }),
      episode('b', { queue: 1000.0001 }),
      episode('c', { queue: 3000 }),
    ]);
    items.moveInQueue('c', ['a', 'c', 'b']);
    expect(api.setMany).toHaveBeenCalledTimes(1);
    expect(api.setMany.mock.calls[0][1]).toEqual([
      {
        path: 'users/u1/feedItems/a',
        data: { queue: 1000, expireAt: 'CLEAR', updatedAt: 'SERVER_TIME' },
      },
      {
        path: 'users/u1/feedItems/c',
        data: { queue: 2000, expireAt: 'CLEAR', updatedAt: 'SERVER_TIME' },
      },
      {
        path: 'users/u1/feedItems/b',
        data: { queue: 3000, expireAt: 'CLEAR', updatedAt: 'SERVER_TIME' },
      },
    ]);
    expect(items.queue().map((i) => i.id)).toEqual(['a', 'c', 'b']);
  });

  it('takes an episode off the queue once heard: to the end, marked, or all marked', () => {
    const { items, api } = queueSetup();
    api.pushQueue([
      episode('a', { queue: 1 }),
      episode('b', { queue: 2 }),
      episode('c', { queue: 3 }),
      episode('d', { queue: 4 }),
    ]);
    items.setProgress('a', { position: 600, played: true });
    expect(api.set.mock.calls.find((c) => c[2]['played'] === true)![2]).toMatchObject({
      queue: 'CLEAR',
    });
    items.setPlayed('b', true);
    expect(api.set.mock.calls.at(-1)![2]).toEqual({
      played: true,
      queue: 'CLEAR',
      updatedAt: 'SERVER_TIME',
    });
    items.setPlayedMany(['c']);
    expect(api.setMany.mock.calls[0][1][0].data).toEqual({
      played: true,
      queue: 'CLEAR',
      updatedAt: 'SERVER_TIME',
    });
    expect(items.queue().map((i) => i.id)).toEqual(['d']);
    // Mark as new leaves the queue alone, and so does a place kept.
    items.setPlayed('d', false);
    items.setProgress('d', { position: 30 });
    expect(items.queue().map((i) => i.id)).toEqual(['d']);
    // Not queued: a heard mark writes no place.
    api.pushFeed('p1', [episode('e')]);
    items.setPlayed('e', true);
    expect(api.set.mock.calls.at(-1)![2]).not.toHaveProperty('queue');
  });
});

describe('each module’s own shelves (#248)', () => {
  const audio = { enclosure: { url: 'https://p.test/a.mp3', type: 'audio/mpeg', seconds: 600 } };
  const SPLIT = [
    'unread:reader',
    'unread:podcasts',
    'read:reader',
    'read:podcasts',
    'saved:reader',
    'saved:podcasts',
  ] as const;

  function stampSetup(local: Storage | null = memoryStorage()) {
    const s = setup(memoryStorage(), local);
    s.feeds.push([
      { id: 'f1', data: { url: 'https://a.test/f', title: 'Design blog', folders: ['Design'] } },
      { id: 'p1', data: { url: 'https://p.test/f', title: 'Pod', folders: [], kind: 'podcast' } },
    ]);
    TestBed.tick();
    return s;
  }
  const ids = (list: { id: string }[]) => list.map((i) => i.id);

  it('keeps the shared shelves until the server’s note, and asks for the backfill once', async () => {
    const { api } = stampSetup();
    expect(api.listen.mock.calls.map((c) => [c[2], c[5]])).toEqual([
      ['unread', undefined],
      ['read', undefined],
      ['saved', undefined],
    ]);
    expect(api.listenStamp.mock.calls[0][1]).toBe('users/u1/settings/readerServer');
    // The cache's "not yet" asks for nothing; the server's does, once a sitting.
    api.pushStamp(false, true);
    expect(api.stampFeedItems).not.toHaveBeenCalled();
    api.pushStamp(false);
    api.pushStamp(false);
    await Promise.resolve();
    expect(api.stampFeedItems).toHaveBeenCalledTimes(1);
    TestBed.tick();
    expect(api.listening()).toEqual(['unread', 'read', 'saved']);
  });

  it('asks again while a run says more is left, a few runs at most', async () => {
    const { api } = stampSetup();
    api.stampFeedItems.mockResolvedValue({ done: false, more: true });
    api.pushStamp(false);
    await vi.waitFor(() => expect(api.stampFeedItems).toHaveBeenCalledTimes(5));
    await new Promise((r) => setTimeout(r));
    expect(api.stampFeedItems).toHaveBeenCalledTimes(5);
  });

  it('splits on the note, keeping the shared shelves beside until the server answers every split one', () => {
    const { api, items, local } = stampSetup();
    api.push('unread', [
      item('a', 'f1', 1),
      item('e', 'p1', 2, audio),
      item('b', 'f1', 3, { podcast: false }),
    ]);
    api.pushStamp(true);
    TestBed.tick();
    expect(api.listen.mock.calls.slice(3).map((c) => `${c[2]}:${c[5]}`)).toEqual([...SPLIT]);
    expect(api.listening()).toEqual(['unread', 'read', 'saved', ...SPLIT]);
    // From the cache, the Reader's own lacks an item it holds from before
    // the backfill: the shared shelf still shows it.
    api.push('unread:reader', [item('b', 'f1', 3, { podcast: false })], true);
    expect(ids(items.inShelf({ kind: 'folder', name: ALL }, false))).toEqual(['a', 'b']);
    expect(ids(items.episodes())).toEqual(['e']);
    for (const key of SPLIT) api.push(key, [], true);
    expect(api.listening()).toContain('unread');
    // The server's answers, every split shelf: the shared ones go.
    api.push('unread:reader', [
      item('a', 'f1', 1, { podcast: false }),
      item('b', 'f1', 3, { podcast: false }),
    ]);
    api.push('unread:podcasts', [item('e', 'p1', 2, { ...audio, podcast: true })]);
    for (const key of SPLIT.filter((k) => !k.startsWith('unread'))) api.push(key, []);
    expect(api.stopped).toEqual(['unread', 'read', 'saved']);
    expect(api.listening()).toEqual([...SPLIT]);
    expect(local?.getItem(`${SPLIT_KEY}.u1`)).toBe('1');
    expect(ids(items.inShelf({ kind: 'folder', name: ALL }, false))).toEqual(['a', 'b']);
    expect(ids(items.episodes())).toEqual(['e']);
    expect(items.unreadCounts()[ALL]).toBe(2);
  });

  it('starts on the split shelves on a device that had them from the server before', () => {
    const local = memoryStorage();
    local.setItem(`${SPLIT_KEY}.u1`, '1');
    const { api, items } = stampSetup(local);
    expect(api.listening()).toEqual([...SPLIT]);
    // The cache's "not yet" leaves them as they are.
    api.pushStamp(false, true);
    TestBed.tick();
    expect(api.listening()).toEqual([...SPLIT]);
    // Loaded once both modules' unread are heard.
    api.push('unread:reader', [item('a', 'f1', 1, { podcast: false })], true);
    expect(items.loaded()).toBe(false);
    api.push('unread:podcasts', [], true);
    expect(items.loaded()).toBe(true);
    expect(ids(items.inShelf({ kind: 'folder', name: ALL }, false))).toEqual(['a']);
  });

  it('shows a moved show’s items where the feed is now, before their restamp lands', () => {
    const local = memoryStorage();
    local.setItem(`${SPLIT_KEY}.u1`, '1');
    const { api, items, feeds } = stampSetup(local);
    api.push('unread:reader', [item('a', 'f1', 1, { podcast: false })]);
    api.push('unread:podcasts', [item('e', 'p1', 2, { ...audio, podcast: true })]);
    // Moved to the Reader: still stamped Podcasts' until the trigger runs.
    feeds.push([
      { id: 'f1', data: { url: 'https://a.test/f', title: 'Design blog', folders: ['Design'] } },
      { id: 'p1', data: { url: 'https://p.test/f', title: 'Pod', folders: [] } },
    ]);
    TestBed.tick();
    expect(ids(items.inShelf({ kind: 'folder', name: ALL }, false))).toEqual(['a', 'e']);
    expect(items.episodes()).toEqual([]);
    // An episode in the Reader's own (the device ahead of the stamp) is
    // still kept off the Reader while its feed is a show.
    feeds.push([
      { id: 'f1', data: { url: 'https://a.test/f', title: 'Design blog', folders: ['Design'] } },
      { id: 'p1', data: { url: 'https://p.test/f', title: 'Pod', folders: [], kind: 'podcast' } },
    ]);
    api.push('unread:reader', [
      item('a', 'f1', 1, { podcast: false }),
      item('e', 'p1', 2, { ...audio, podcast: false }),
    ]);
    TestBed.tick();
    expect(ids(items.inShelf({ kind: 'folder', name: ALL }, false))).toEqual(['a']);
    expect(ids(items.episodes())).toEqual(['e']);
  });

  it('runs the shared shelves beside every time when the device cannot keep the mark', () => {
    const { api } = stampSetup(null);
    api.pushStamp(true);
    TestBed.tick();
    for (const key of SPLIT) api.push(key, []);
    expect(api.listening()).toEqual([...SPLIT]);
    TestBed.resetTestingModule();
    const again = stampSetup(null);
    expect(again.api.listening()).toEqual(['unread', 'read', 'saved']);
  });
});
