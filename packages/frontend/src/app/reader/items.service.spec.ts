import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW, SESSION_STORAGE } from '../platform/platform';
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
import { ALL, ITEMS_API, ItemsService, SAVED, VISITED_KEY } from './items.service';
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

function setup(session: Storage | null = memoryStorage()) {
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
    ],
  });
  const items = TestBed.inject(ItemsService);
  TestBed.tick();
  feeds.push([
    { id: 'f1', data: { url: 'https://a.test/f', title: 'Design blog', folders: ['Design'] } },
    { id: 'f2', data: { url: 'https://b.test/f', title: 'Dice', folders: ['Games', 'Design'] } },
    { id: 'f3', data: { url: 'https://c.test/f', title: 'Loose', folders: [] } },
  ]);
  return { items, api, feeds, user, modules, notes, reading, settings };
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
