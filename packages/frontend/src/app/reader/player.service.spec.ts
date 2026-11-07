import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW, STORAGE } from '../platform/platform';
import { ReadingService } from '../reading/reading.service';
import {
  FakeAudio,
  FakeItemsApi,
  FakeModules,
  FakeNotes,
  FakeReaderApi,
  FakeSettingsApi,
  fakeFirebase,
} from '../testing/fakes';
import { SETTINGS_API } from '../theme/theme-sync.service';
import { ITEMS_API, ItemsService } from './items.service';
import { AUDIO_FACTORY, PlayerService } from './player.service';
import { READER_API } from './reader.service';

const NOW_MS = Date.parse('2026-11-07T12:00:00Z');
const stamp = (ms: number) => ({ toMillis: () => ms });

const episode = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  data: {
    feedId: 'pod',
    title: `Episode ${id}`,
    link: `https://pod.test/${id}`,
    published: stamp(NOW_MS),
    summary: '',
    content: '',
    read: false,
    saved: false,
    enclosure: { url: `https://pod.test/${id}.mp3`, type: 'audio/mpeg', seconds: 2530 },
    image: `https://pod.test/${id}.jpg`,
    ...more,
  },
});

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
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

function setup(storage = memoryStorage()) {
  const api = new FakeItemsApi();
  const feeds = new FakeReaderApi();
  const modules = new FakeModules();
  modules.set('reader', true);
  const audio = new FakeAudio();
  const made = vi.fn(() => audio);
  const user = signal<User | null | undefined>({ uid: 'u1' } as User);
  TestBed.configureTestingModule({
    providers: [
      { provide: FIREBASE, useValue: fakeFirebase(true) },
      { provide: ITEMS_API, useValue: api },
      { provide: NotesService, useValue: new FakeNotes() },
      { provide: ReadingService, useValue: { save: vi.fn() } },
      { provide: READER_API, useValue: feeds },
      { provide: SETTINGS_API, useValue: new FakeSettingsApi() },
      { provide: ModulesService, useValue: modules },
      { provide: AuthService, useValue: { user } },
      { provide: NOW, useValue: () => NOW_MS },
      { provide: STORAGE, useValue: storage },
      { provide: AUDIO_FACTORY, useValue: made },
    ],
  });
  const items = TestBed.inject(ItemsService);
  const player = TestBed.inject(PlayerService);
  TestBed.tick();
  feeds.push([
    {
      id: 'pod',
      data: { url: 'https://pod.test/f', title: 'Kiln hour', folders: [], kind: 'podcast' },
    },
  ]);
  /** The writes of the listening position, in order. */
  const progress = () =>
    api.set.mock.calls
      .filter((c) => 'position' in c[2])
      .map((c) => ({ path: c[1], ...c[2] }) as Record<string, unknown>);
  return { items, player, api, audio, made, storage, progress };
}

describe('PlayerService (#179)', () => {
  it('makes no audio until something plays, then plays from the kept place at the kept speed', () => {
    const { items, player, api, audio, made, storage } = setup(
      memoryStorage({ 'goblin.player.rate': '1.5' }),
    );
    api.push('unread', [episode('e1', { position: 754, playedAt: stamp(NOW_MS - 1000) })]);
    player.load(items.find('e1')!, { autoplay: false });
    expect(made).not.toHaveBeenCalled();
    expect(player.current()).toBe('e1');
    expect(player.position()).toBe(754);
    expect(player.duration()).toBe(2530);
    expect(storage.getItem('goblin.player.current')).toBe('e1');

    player.toggle();
    expect(made).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe('https://pod.test/e1.mp3');
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.currentTime).toBe(754);
    expect(player.playing()).toBe(true);
    // The real length, once the metadata lands.
    audio.currentTime = 0;
    audio.meta(2533);
    expect(player.duration()).toBe(2533);
    expect(audio.currentTime).toBe(754);
  });

  it('writes the place every 15 s of play, on pause and on seek, and never reads it', () => {
    const { items, player, api, audio, progress } = setup();
    api.push('unread', [episode('e1')]);
    player.load(items.find('e1')!, { autoplay: true });
    audio.meta(2530);
    audio.tick(5);
    audio.tick(14);
    expect(progress()).toEqual([]);
    audio.tick(15.2);
    expect(progress()).toEqual([
      {
        path: 'users/u1/feedItems/e1',
        position: 15.2,
        playedAt: 'SERVER_TIME',
        played: false,
        updatedAt: 'SERVER_TIME',
      },
    ]);
    audio.tick(20);
    audio.pause();
    expect(player.playing()).toBe(false);
    expect(progress().at(-1)?.['position']).toBe(20);
    player.skip(30);
    expect(audio.currentTime).toBe(50);
    expect(progress().at(-1)?.['position']).toBe(50);
    player.skip(-15);
    expect(progress().at(-1)?.['position']).toBe(35);
    player.seek(-4);
    expect(player.position()).toBe(0);
    expect(progress().every((w) => !('read' in w))).toBe(true);
  });

  it('marks an episode heard to the end played and read, its place at the end', () => {
    const { items, player, api, audio, progress } = setup();
    api.push('unread', [episode('e1')]);
    player.load(items.find('e1')!, { autoplay: true });
    audio.meta(3);
    audio.tick(1);
    audio.end();
    const writes = progress();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      position: 3,
      played: true,
      read: true,
      readAt: 'SERVER_TIME',
    });
    expect(items.find('e1')?.read).toBe(true);
    expect(player.playing()).toBe(false);
  });

  it('offers another device’s newer place, never jumping to it, and not its own echo', () => {
    const { items, player, api, audio } = setup();
    api.push('unread', [episode('e1', { position: 100, playedAt: stamp(NOW_MS - 60_000) })]);
    player.load(items.find('e1')!, { autoplay: true });
    audio.meta(2530);
    audio.tick(116);
    // The echo of this device's write: the place it wrote.
    api.push('unread', [episode('e1', { position: 116, playedAt: stamp(NOW_MS) })]);
    TestBed.tick();
    expect(player.offer()).toBeUndefined();
    // An older write from elsewhere is not offered either.
    api.push('unread', [episode('e1', { position: 300, playedAt: stamp(NOW_MS - 1) })]);
    TestBed.tick();
    expect(player.offer()).toBeUndefined();
    // Another device, newer: offered, and the player stays where it is.
    api.push('unread', [episode('e1', { position: 754, playedAt: stamp(NOW_MS + 5000) })]);
    TestBed.tick();
    expect(player.offer()).toBe(754);
    expect(audio.currentTime).toBe(116);
    expect(player.position()).toBe(116);
    player.takeOffer();
    expect(audio.currentTime).toBe(754);
    api.push('unread', [episode('e1', { position: 754, playedAt: stamp(NOW_MS + 6000) })]);
    TestBed.tick();
    expect(player.offer()).toBeUndefined();
  });

  it('cycles the four speeds and keeps the choice on the device', () => {
    const { player, storage } = setup();
    expect(player.rate()).toBe(1);
    const seen = [1, 2, 3, 4].map(() => (player.nextRate(), player.rate()));
    expect(seen).toEqual([1.25, 1.5, 2, 1]);
    player.setRate(2);
    expect(storage.getItem('goblin.player.rate')).toBe('2');
  });

  it('finds the remembered episode after a reload, paused at its place; stop puts it down', () => {
    const storage = memoryStorage({ 'goblin.player.current': 'e1' });
    const { player, api, audio, made, progress } = setup(storage);
    expect(player.current()).toBeUndefined();
    api.push('unread', [episode('e1', { position: 42, playedAt: stamp(NOW_MS) })]);
    TestBed.tick();
    expect(player.current()).toBe('e1');
    expect(player.position()).toBe(42);
    expect(player.playing()).toBe(false);
    expect(made).not.toHaveBeenCalled();
    player.toggle();
    audio.meta(2530);
    audio.tick(50);
    player.stop();
    expect(progress().at(-1)?.['position']).toBe(50);
    expect(player.current()).toBeUndefined();
    expect(audio.src).toBe('');
    expect(storage.getItem('goblin.player.current')).toBeNull();
  });

  it('keeps the place of the episode it puts down for another', () => {
    const { items, player, api, audio, progress } = setup();
    api.push('unread', [episode('e1'), episode('e2', { position: 9 })]);
    player.load(items.find('e1')!, { autoplay: true });
    audio.meta(2530);
    audio.tick(8);
    player.load(items.find('e2')!, { autoplay: true });
    expect(progress()[0]).toMatchObject({ path: 'users/u1/feedItems/e1', position: 8 });
    expect(audio.src).toBe('https://pod.test/e2.mp3');
    expect(audio.currentTime).toBe(9);
  });
});
