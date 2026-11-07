import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NOW } from '../platform/platform';
import {
  FakeItemsApi,
  FakeModules,
  FakeReaderApi,
  FakeSettingsApi,
  fakeFirebase,
} from '../testing/fakes';
import { SETTINGS_API } from '../theme/theme-sync.service';
import { ALL, ITEMS_API, ItemsService, SAVED } from './items.service';
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

function setup() {
  const api = new FakeItemsApi();
  const feeds = new FakeReaderApi();
  const modules = new FakeModules();
  modules.set('reader', true);
  const user = signal<User | null | undefined>({ uid: 'u1' } as User);
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: ITEMS_API, useValue: api },
      { provide: READER_API, useValue: feeds },
      { provide: SETTINGS_API, useValue: new FakeSettingsApi() },
      { provide: ModulesService, useValue: modules },
      { provide: AuthService, useValue: { user } },
      { provide: NOW, useValue: () => NOW_MS },
    ],
  });
  const items = TestBed.inject(ItemsService);
  TestBed.tick();
  feeds.push([
    { id: 'f1', data: { url: 'https://a.test/f', title: 'Design blog', folders: ['Design'] } },
    { id: 'f2', data: { url: 'https://b.test/f', title: 'Dice', folders: ['Games', 'Design'] } },
    { id: 'f3', data: { url: 'https://c.test/f', title: 'Loose', folders: [] } },
  ]);
  return { items, api, feeds, user, modules };
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
    expect(api.set.mock.lastCall![2]).toEqual({ saved: true, updatedAt: 'SERVER_TIME' });
    // The listener's echo carries the mark; the local copy goes.
    api.push('unread', [item('a', 'f1', 1), item('b', 'f2', 2, { saved: true })]);
    expect(items.find('b')?.saved).toBe(true);
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

  it('listens to nothing while the module is off', () => {
    const { api, modules } = setup();
    modules.set('reader', false);
    TestBed.tick();
    expect(api.listen).toHaveBeenCalledTimes(3);
  });
});
