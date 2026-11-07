import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { STORAGE } from '../platform/platform';
import { DownloadsService } from './downloads.service';
import { type ItemRecord, ItemsService } from './items.service';
import { PlayerPresence } from './player-presence';
import { ReaderService } from './reader.service';

/** The parts of an audio element the player uses, so specs can pass a fake (#179). */
export interface AudioLike {
  src: string;
  preload: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
}

/** Makes the one audio element, the first time something plays. */
export const AUDIO_FACTORY = new InjectionToken<() => AudioLike>('audio-factory', {
  providedIn: 'root',
  factory: () => () => new Audio(),
});

/** The speeds Eric chose (2026-11-07, on #177). */
export const RATES = [1, 1.25, 1.5, 2] as const;
/** Seconds of play between writes of the position. */
export const SAVE_EVERY = 15;
/** How far another device's position must be from this one's to be offered. */
const NEAR = 2;
const RATE_KEY = 'goblin.player.rate';

/**
 * The podcast player (#179): one audio element for the whole app,
 * made lazily, playing a downloaded episode from the cache through the
 * proxy's link, which the service worker answers offline (#180), and
 * any other straight from the enclosure's link. The position is kept on the item, through the
 * persistent cache, every 15 seconds of play and on pause, seek, stop
 * and leaving the page; the episode in hand is remembered on the
 * device, so a reload finds it where it was. Heard to the end, it is
 * marked played and read.
 *
 * Another device's position, newer than anything this one wrote, is
 * offered (`offer`), never jumped to: the newest playedAt wins, but
 * the local player does not move under the listener.
 */
@Injectable({ providedIn: 'root' })
export class PlayerService {
  private readonly items = inject(ItemsService);
  private readonly reader = inject(ReaderService);
  private readonly makeAudio = inject(AUDIO_FACTORY);
  private readonly storage = inject(STORAGE);
  private readonly presence = inject(PlayerPresence);
  private readonly downloads = inject(DownloadsService);

  private audio?: AudioLike;
  /** Whether the audio element holds the current episode's link yet. */
  private attached = false;
  /** Where to start once the audio has its metadata. */
  private startAt?: number;
  /** The position at the last write, for the 15 s rhythm. */
  private savedAt = 0;
  /** Whether the position moved since the last write. */
  private dirty = false;
  /** The record loaded, kept in case the item leaves the shelves. */
  private readonly loaded = signal<ItemRecord | undefined>(undefined);
  /** The position this device last wrote or started from. */
  private readonly written = signal(0);
  /** The newest playedAt this device has seen as its own or started from. */
  private readonly seenAt = signal(0);

  /** The episode in hand, by item id. */
  readonly current = signal<string | undefined>(undefined);
  readonly playing = signal(false);
  /** Seconds. */
  readonly position = signal(0);
  /** Seconds: the audio's own once known, the feed's until then. */
  readonly duration = signal(0);
  readonly rate = signal<number>(this.storedRate());

  /** The episode in hand, as the listeners have it now. */
  readonly item = computed(() => {
    const id = this.current();
    if (!id) return undefined;
    return this.items.find(id) ?? this.loaded();
  });

  /**
   * Another device's newer position (#179), seconds, for "Continue
   * from 12:34": a playedAt newer than this device has seen, at a
   * position away from the one it wrote.
   */
  readonly offer = computed(() => {
    const it = this.item();
    if (!it || it.position === undefined || it.playedAt === undefined) return undefined;
    if (it.playedAt <= this.seenAt()) return undefined;
    if (Math.abs(it.position - this.written()) < NEAR) return undefined;
    return it.position;
  });

  constructor() {
    // The echo of this device's own write carries the position it
    // wrote: its playedAt is then seen, first as the cache's estimate
    // and then as the server's clock, which other devices' writes are
    // stamped by too.
    effect(() => {
      const it = this.item();
      if (!it || it.playedAt === undefined || it.position === undefined) return;
      const { position, playedAt } = it;
      untracked(() => {
        if (Math.abs(position - this.written()) < NEAR) this.seenAt.set(playedAt);
      });
    });
    // After a reload, the episode this device had in hand, paused where it was.
    const remembered = this.presence.id();
    if (remembered) {
      const restore = effect(() => {
        const it = this.items.find(remembered);
        if (this.current()) return restore.destroy();
        if (!it?.enclosure) {
          if (this.items.loaded() && !it) this.presence.set(undefined);
          return;
        }
        untracked(() => this.load(it, { autoplay: false }));
        restore.destroy();
      });
    }
    if (typeof window !== 'undefined') {
      const flush = () => this.flush();
      const hidden = () => {
        if (document.visibilityState === 'hidden') this.flush();
      };
      window.addEventListener('pagehide', flush);
      window.addEventListener('beforeunload', flush);
      document.addEventListener('visibilitychange', hidden);
      inject(DestroyRef).onDestroy(() => {
        window.removeEventListener('pagehide', flush);
        window.removeEventListener('beforeunload', flush);
        document.removeEventListener('visibilitychange', hidden);
      });
    }
  }

  /**
   * Puts an episode in hand, at its kept position (from the start once
   * played), and plays it when asked. Another episode playing is paused
   * and its position kept first.
   */
  load(item: ItemRecord, { autoplay }: { autoplay: boolean }): void {
    if (!item.enclosure) return;
    if (this.current() === item.id) {
      if (autoplay && !this.playing()) this.play();
      return;
    }
    if (this.current()) this.detach();
    const start = item.played ? 0 : (item.position ?? 0);
    this.loaded.set(item);
    this.current.set(item.id);
    this.position.set(start);
    this.duration.set(item.enclosure.seconds ?? 0);
    this.written.set(start);
    this.seenAt.set(item.playedAt ?? 0);
    this.savedAt = start;
    this.dirty = false;
    this.presence.set(item.id);
    this.setMetadata(item);
    if (autoplay) this.play();
  }

  toggle(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  play(): void {
    const it = this.item();
    if (!it?.enclosure) return;
    const audio = this.element();
    if (!this.attached) {
      this.attached = true;
      this.startAt = this.position();
      audio.src = this.downloads.source(it) ?? it.enclosure.url;
      audio.defaultPlaybackRate = this.rate();
      audio.playbackRate = this.rate();
      // Before the metadata this is the default start; again once it lands.
      audio.currentTime = this.position();
    }
    audio.play().catch((err) => {
      console.error('could not play', err);
      this.playing.set(false);
    });
  }

  pause(): void {
    this.audio?.pause();
  }

  /** Moves to a place in the episode, and keeps it. */
  seek(seconds: number): void {
    if (!this.current()) return;
    const end = this.duration() || Infinity;
    const to = Math.min(Math.max(0, seconds), end);
    this.position.set(to);
    if (this.attached && this.audio) {
      if (this.startAt !== undefined) this.startAt = to;
      this.audio.currentTime = to;
    }
    this.dirty = true;
    this.save();
  }

  /** Back 15 seconds or on 30. */
  skip(by: -15 | 30): void {
    this.seek(this.position() + by);
  }

  setRate(rate: number): void {
    this.rate.set(rate);
    if (this.audio) {
      this.audio.defaultPlaybackRate = rate;
      this.audio.playbackRate = rate;
    }
    this.write(RATE_KEY, String(rate));
  }

  /** The next speed after this one, round again after 2×. */
  nextRate(): void {
    const at = RATES.indexOf(this.rate() as (typeof RATES)[number]);
    this.setRate(RATES[(at + 1) % RATES.length]);
  }

  /** Keeps the position and puts the episode down; the bar goes. */
  stop(): void {
    if (!this.current()) return;
    this.detach();
    this.current.set(undefined);
    this.loaded.set(undefined);
    this.playing.set(false);
    this.position.set(0);
    this.duration.set(0);
    this.presence.set(undefined);
    this.clearMetadata();
  }

  /** "Continue from 12:34" taken: the other device's place. */
  takeOffer(): void {
    const at = this.offer();
    if (at !== undefined) this.seek(at);
  }

  /** Writes the position now if it moved, as the page goes. */
  flush(): void {
    if (this.dirty) this.save();
  }

  private save(played = false): void {
    const id = this.current();
    if (!id) return;
    const position = this.position();
    this.written.set(position);
    this.savedAt = position;
    this.dirty = false;
    this.items.setProgress(id, { position, ...(played ? { played: true } : {}) });
  }

  /** Pauses, keeps the position, and empties the element. */
  private detach(): void {
    this.flush();
    if (this.audio && this.attached) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.attached = false;
    this.startAt = undefined;
    this.playing.set(false);
  }

  private element(): AudioLike {
    if (this.audio) return this.audio;
    const audio = this.makeAudio();
    audio.preload = 'metadata';
    const onMeta = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) this.duration.set(audio.duration);
      if (this.startAt !== undefined) {
        const to = this.startAt;
        this.startAt = undefined;
        if (Math.abs(audio.currentTime - to) > 0.5) audio.currentTime = to;
      }
    };
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('timeupdate', () => {
      if (!this.attached || this.startAt !== undefined) return;
      const at = audio.currentTime;
      if (at !== this.position()) {
        this.position.set(at);
        this.dirty = true;
      }
      if (!audio.paused && Math.abs(at - this.savedAt) >= SAVE_EVERY) this.save();
      this.setPositionState();
    });
    audio.addEventListener('play', () => {
      this.playing.set(true);
      this.setPlaybackState('playing');
    });
    audio.addEventListener('pause', () => {
      this.playing.set(false);
      this.setPlaybackState('paused');
      // At the end, `ended` keeps it, as played.
      if (!audio.ended) this.flush();
    });
    audio.addEventListener('ended', () => {
      this.playing.set(false);
      this.position.set(this.duration() || audio.currentTime);
      this.save(true);
    });
    this.setActionHandlers();
    this.audio = audio;
    return audio;
  }

  // The Media Session (#179): the lock screen and headphone buttons.

  private session(): MediaSession | undefined {
    return typeof navigator !== 'undefined' && 'mediaSession' in navigator
      ? navigator.mediaSession
      : undefined;
  }

  private setMetadata(item: ItemRecord): void {
    const session = this.session();
    if (!session || typeof MediaMetadata === 'undefined') return;
    const feed = this.reader.feeds().find((f) => f.id === item.feedId);
    session.metadata = new MediaMetadata({
      title: item.title,
      artist: feed?.title ?? '',
      artwork: item.image && this.reader.images() ? [{ src: item.image }] : [],
    });
  }

  private clearMetadata(): void {
    const session = this.session();
    if (session) session.metadata = null;
  }

  private setPlaybackState(state: MediaSessionPlaybackState): void {
    const session = this.session();
    if (session) session.playbackState = state;
  }

  private setPositionState(): void {
    const session = this.session();
    const duration = this.duration();
    if (!session?.setPositionState || !duration) return;
    try {
      session.setPositionState({
        duration,
        playbackRate: this.rate(),
        position: Math.min(this.position(), duration),
      });
    } catch {
      // A browser that disagrees about the numbers shows no position.
    }
  }

  private setActionHandlers(): void {
    const session = this.session();
    if (!session) return;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => this.play()],
      ['pause', () => this.pause()],
      ['seekbackward', () => this.skip(-15)],
      ['seekforward', () => this.skip(30)],
      ['seekto', (d) => d.seekTime !== undefined && this.seek(d.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // An action this browser does not offer.
      }
    }
  }

  private storedRate(): number {
    const r = Number(this.read(RATE_KEY));
    return (RATES as readonly number[]).includes(r) ? r : 1;
  }

  private read(key: string): string | undefined {
    try {
      return this.storage?.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: string | undefined): void {
    try {
      if (value === undefined) this.storage?.removeItem(key);
      else this.storage?.setItem(key, value);
    } catch {
      // Storage refused: the choice lasts this visit.
    }
  }
}
