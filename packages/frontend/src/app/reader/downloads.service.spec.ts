import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW, ONLINE, STORAGE } from '../platform/platform';
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
import { DownloadPrefs, MB } from './download-prefs';
import { DOWNLOADS_API, DownloadsService, episodePath, onWifi, size } from './downloads.service';
import { ITEMS_API, ItemsService } from './items.service';
import { PlayerPresence } from './player-presence';
import { READER_API } from './reader.service';

const NOW_MS = Date.parse('2026-11-07T12:00:00Z');
const stamp = (ms: number) => ({ toMillis: () => ms });
const link = (id: string) => `https://pod.test/${id}.mp3`;

const episode = (id: string, daysAgo: number, more: Record<string, unknown> = {}) => ({
  id,
  data: {
    feedId: 'pod',
    title: `Episode ${id}`,
    link: `https://pod.test/${id}`,
    published: stamp(NOW_MS - daysAgo * 86_400_000),
    summary: '',
    content: '',
    read: false,
    saved: false,
    enclosure: { url: link(id), type: 'audio/mpeg', seconds: 2530 },
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

async function setup(seed?: (api: FakeDownloadsApi) => Promise<void>) {
  const api = new FakeItemsApi();
  const downloadsApi = new FakeDownloadsApi();
  await seed?.(downloadsApi);
  const modules = new FakeModules();
  modules.set('reader', true);
  const online = signal(true);
  const getIdToken = vi.fn(async () => 'id-token');
  const user = signal<User | null | undefined>({ uid: 'u1', getIdToken } as unknown as User);
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: ITEMS_API, useValue: api },
      { provide: NotesService, useValue: new FakeNotes() },
      { provide: ReadingService, useValue: { save: vi.fn() } },
      { provide: READER_API, useValue: new FakeReaderApi() },
      { provide: SETTINGS_API, useValue: new FakeSettingsApi() },
      { provide: ModulesService, useValue: modules },
      { provide: AuthService, useValue: { user } },
      { provide: NOW, useValue: () => NOW_MS },
      { provide: STORAGE, useValue: memoryStorage() },
      { provide: ONLINE, useValue: () => online() },
      { provide: DOWNLOADS_API, useValue: downloadsApi },
    ],
  });
  const items = TestBed.inject(ItemsService);
  const downloads = TestBed.inject(DownloadsService);
  const prefs = TestBed.inject(DownloadPrefs);
  const presence = TestBed.inject(PlayerPresence);
  TestBed.tick();
  // The cache is read once at the start.
  await vi.waitFor(() => expect(downloads.loaded()).toBe(true));
  /** Lets effects run and any automatic downloads finish. */
  const settle = async () => {
    TestBed.tick();
    await downloads.settled();
  };
  return { api, downloadsApi, items, downloads, prefs, presence, online, getIdToken, settle };
}

describe('DownloadsService (#180)', () => {
  it('downloads by hand through the proxy with the ID token, and plays it from there', async () => {
    const { api, downloadsApi, items, downloads } = await setup();
    api.push('unread', [episode('e1', 1)]);
    const it = items.find('e1')!;
    expect(downloads.source(it)).toBe(link('e1'));
    expect(await downloads.download(it)).toBeUndefined();
    const [url, init] = downloadsApi.fetch.mock.calls[0];
    expect(url).toBe(`/api/episode?url=${encodeURIComponent(link('e1'))}`);
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer id-token');
    expect(downloads.has('e1')).toBe(true);
    expect(downloads.total()).toBe(1000);
    expect(downloads.list().map((r) => [r.id, r.title, r.bytes, r.auto])).toEqual([
      ['e1', 'Episode e1', 1000, false],
    ]);
    expect(downloads.source(it)).toBe(episodePath(link('e1')));
    const kept = downloadsApi.cache.stored.get(episodePath(link('e1')))!;
    expect(kept.body.length).toBe(1000);
    expect(kept.headers.get('content-type')).toBe('audio/mpeg');
    expect(kept.headers.get('x-mossgoblin-item')).toBe('e1');

    await downloads.remove('e1');
    expect(downloads.has('e1')).toBe(false);
    expect(downloadsApi.cache.stored.size).toBe(0);
    expect(downloads.source(it)).toBe(link('e1'));
  });

  it('reads what the cache already holds, sizes included', async () => {
    const { downloads } = await setup(async (d) => {
      await d.cache.put(
        episodePath(link('old')),
        new Response(new Uint8Array(321), {
          headers: {
            'content-type': 'audio/mpeg',
            'x-mossgoblin-item': 'old',
            'x-mossgoblin-feed': 'pod',
            'x-mossgoblin-title': encodeURIComponent('Kilns · part 2'),
            'x-mossgoblin-published': String(NOW_MS),
            'x-mossgoblin-source': encodeURIComponent(link('old')),
            'x-mossgoblin-auto': '1',
          },
        }),
      );
      // Not one of ours: left alone.
      await d.cache.put('/elsewhere', new Response('x'));
    });
    expect(downloads.list()).toEqual([
      {
        id: 'old',
        feedId: 'pod',
        title: 'Kilns · part 2',
        published: NOW_MS,
        url: link('old'),
        bytes: 321,
        auto: true,
      },
    ]);
  });

  it('downloads by hand on any connection, but needs the network', async () => {
    expect(onWifi(undefined)).toBe(true);
    expect(onWifi({ type: 'wifi' })).toBe(true);
    expect(onWifi({ saveData: false })).toBe(true);
    expect(onWifi({ type: 'cellular' })).toBe(false);
    expect(onWifi({ saveData: true })).toBe(false);
    const { api, downloadsApi, items, downloads, prefs, online } = await setup();
    api.push('unread', [episode('e1', 1)]);
    downloadsApi.conn = { type: 'cellular' };
    expect(prefs.wifiOnly()).toBe(true);
    online.set(false);
    expect(await downloads.download(items.find('e1')!)).toMatch(/needs the network/);
    expect(downloadsApi.fetch).not.toHaveBeenCalled();
    online.set(true);
    expect(await downloads.download(items.find('e1')!)).toBeUndefined();
    expect(downloads.has('e1')).toBe(true);
  });

  it('makes room under the cap by hand, the oldest first, never the episode in hand', async () => {
    const { api, downloadsApi, items, downloads, prefs, presence } = await setup();
    prefs.setCap(250);
    api.push('unread', [episode('e1', 3), episode('e2', 2), episode('e3', 1)]);
    // The fake states these sizes; the bytes sent are few.
    downloadsApi.sizes = { [link('e1')]: 100 * MB, [link('e2')]: 100 * MB, [link('e3')]: 100 * MB };
    downloadsApi.fetch.mockImplementation(async (url: string) => {
      const l = decodeURIComponent(url.split('url=')[1]);
      return new Response(new Uint8Array(10), {
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(downloadsApi.sizes[l]) },
      });
    });
    expect(await downloads.download(items.find('e1')!)).toBeUndefined();
    expect(await downloads.download(items.find('e2')!)).toBeUndefined();
    expect(downloads.total()).toBe(200 * MB);
    expect(await downloads.download(items.find('e3')!)).toBeUndefined();
    expect(downloads.list().map((r) => r.id)).toEqual(['e3', 'e2']);
    // The oldest kept is in hand: no room, nothing removed.
    presence.set('e2');
    downloadsApi.sizes[link('e1')] = 200 * MB;
    expect(await downloads.download(items.find('e1')!)).toBe(
      'No room under the 250 MB kept for downloads.',
    );
    expect(downloads.list().map((r) => r.id)).toEqual(['e3', 'e2']);
    // Bigger than the cap itself.
    downloadsApi.sizes[link('e1')] = 300 * MB;
    expect(await downloads.download(items.find('e1')!)).toMatch(/bigger than the 250 MB/);
  });

  it('lets the oldest go when the cap is lowered', async () => {
    const { api, downloadsApi, items, downloads, prefs } = await setup();
    downloadsApi.fetch.mockImplementation(
      async () =>
        new Response(new Uint8Array(10), {
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(150 * MB) },
        }),
    );
    api.push('unread', [episode('e1', 3), episode('e2', 2), episode('e3', 1)]);
    for (const id of ['e1', 'e2', 'e3']) await downloads.download(items.find(id)!);
    expect(downloads.total()).toBe(450 * MB);
    prefs.setCap(250);
    TestBed.tick();
    await vi.waitFor(() => expect(downloads.list().map((r) => r.id)).toEqual(['e3']));
  });

  it('keeps a podcast’s newest N downloaded as episodes arrive, letting the older ones go', async () => {
    const { api, downloadsApi, items, downloads, prefs, settle } = await setup();
    api.push('unread', [episode('e1', 3), episode('e2', 2)]);
    await settle();
    expect(downloadsApi.fetch).not.toHaveBeenCalled();
    // By hand, kept whatever the N.
    expect(await downloads.download(items.find('e1')!)).toBeUndefined();
    prefs.setKeep('pod', 1);
    await settle();
    expect(downloads.list().map((r) => [r.id, r.auto])).toEqual([
      ['e2', true],
      ['e1', false],
    ]);
    // A new episode: it comes, the older automatic one goes.
    api.push('unread', [episode('e1', 3), episode('e2', 2), episode('e3', 0)]);
    await settle();
    expect(downloads.list().map((r) => r.id)).toEqual(['e3', 'e1']);
    // Played ones are not wanted.
    api.push('unread', [episode('e1', 3), episode('e2', 2), episode('e3', 0, { played: true })]);
    await settle();
    expect(downloads.list().map((r) => r.id)).toEqual(['e2', 'e1']);
    // An automatic download whose item is not at hand yet stays.
    api.push('unread', [episode('e1', 3)]);
    await settle();
    expect(downloads.list().map((r) => r.id)).toEqual(['e2', 'e1']);
    // Not on Wi-Fi: nothing new starts on its own, until Wi-Fi only is off.
    downloadsApi.conn = { type: 'cellular' };
    prefs.setKeep('pod', 2);
    api.push('unread', [episode('e1', 3), episode('e2', 2), episode('e4', 0)]);
    await settle();
    expect(downloads.has('e4')).toBe(false);
    prefs.setWifiOnly(false);
    api.push('unread', [episode('e1', 3), episode('e2', 2), episode('e4', 0)]);
    await settle();
    expect(downloads.has('e4')).toBe(true);
  });

  it('downloads automatically only into the room under the cap', async () => {
    const { api, downloadsApi, items, downloads, prefs, settle } = await setup();
    prefs.setCap(250);
    downloadsApi.fetch.mockImplementation(
      async () =>
        new Response(new Uint8Array(10), {
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(100 * MB) },
        }),
    );
    api.push('unread', [episode('e1', 3), episode('e2', 2)]);
    await downloads.download(items.find('e1')!);
    await downloads.download(items.find('e2')!);
    prefs.setKeep('pod', 3);
    api.push('unread', [episode('e1', 3), episode('e2', 2), episode('e3', 1), episode('e4', 0)]);
    await settle();
    // e4 did not fit, so it is not there, and nothing by hand went.
    expect(downloads.list().map((r) => r.id)).toEqual(['e2', 'e1']);
  });

  it('counts a file that states no size, and shows sizes plainly', async () => {
    const { api, downloadsApi, items, downloads } = await setup();
    downloadsApi.stateLength = false;
    downloadsApi.sizes = { [link('e1')]: 4321 };
    api.push('unread', [episode('e1', 1)]);
    await downloads.download(items.find('e1')!);
    expect(downloads.total()).toBe(4321);
    expect(size(4321)).toBe('4 KB');
    expect(size(3.25 * MB)).toBe('3.3 MB');
    expect(size(120 * MB)).toBe('120 MB');
  });

  it('keeps its settings on the device: 500 MB and Wi-Fi only until changed', async () => {
    const { prefs } = await setup();
    expect(prefs.capMb()).toBe(500);
    expect(prefs.wifiOnly()).toBe(true);
    expect(prefs.keepsAny()).toBe(false);
    prefs.setCap(1000);
    prefs.setCap(123);
    prefs.setWifiOnly(false);
    prefs.setKeep('pod', 3);
    prefs.setKeep('other', 7);
    expect(prefs.capMb()).toBe(1000);
    expect(prefs.keepFor('pod')).toBe(3);
    expect(prefs.keepFor('other')).toBe(0);
    const stored = JSON.parse(TestBed.inject(STORAGE)!.getItem('goblin.downloads.prefs')!);
    expect(stored).toEqual({ capMb: 1000, wifiOnly: false, keep: { pod: 3 } });
    prefs.setKeep('pod', 0);
    expect(prefs.keepsAny()).toBe(false);
  });
});
