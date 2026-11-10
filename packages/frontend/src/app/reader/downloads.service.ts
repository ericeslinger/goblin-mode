import {
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { AuthService } from '../auth.service';
import { ONLINE } from '../platform/platform';
import { DownloadPrefs, MB } from './download-prefs';
import { type ItemRecord, ItemsService } from './items.service';
import { PlayerPresence } from './player-presence';

/** The Cache Storage cache the episodes are kept in; sw.js reads it too (#180). */
export const EPISODE_CACHE = 'mossgoblin-episodes';

/** The app's own link for an episode: the Worker's proxy, which sw.js answers from the cache. */
export function episodePath(enclosureUrl: string): string {
  return `/api/episode?url=${encodeURIComponent(enclosureUrl)}`;
}

/** What the browser says about the connection (the Network Information API), when it says. */
export interface ConnectionInfo {
  type?: string;
  saveData?: boolean;
}

/**
 * Whether a download may start on this connection (#180): no
 * information allows it; cellular, Bluetooth tethering or Data Saver
 * do not. Chrome on Android reports the type, desktop browsers mostly
 * do not, and Safari has no such API.
 */
export function onWifi(connection: ConnectionInfo | undefined): boolean {
  if (!connection) return true;
  if (connection.type === 'cellular' || connection.type === 'bluetooth') return false;
  return connection.saveData !== true;
}

/** The parts of a Cache the service uses; the browser's own satisfies it. */
export interface EpisodeCache {
  keys(): Promise<readonly { url: string }[]>;
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
}

/** The browser calls the service makes, as a seam for unit specs. */
export interface DownloadsApi {
  open(): Promise<EpisodeCache>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  connection(): ConnectionInfo | undefined;
}

export const DOWNLOADS_API = new InjectionToken<DownloadsApi>('downloads-api', {
  providedIn: 'root',
  factory: () => ({
    open: () => caches.open(EPISODE_CACHE),
    fetch: (url, init) => fetch(url, init),
    connection: () => (navigator as { connection?: ConnectionInfo }).connection,
  }),
});

/** A downloaded episode, as its cached response's headers describe it. */
export interface DownloadRecord {
  /** The item's id. */
  id: string;
  feedId: string;
  title: string;
  /** Milliseconds. */
  published: number;
  /** The enclosure's link it was downloaded from. */
  url: string;
  bytes: number;
  /** Downloaded because its podcast keeps its newest N, not by hand. */
  auto: boolean;
}

/** How a download is going: bytes so far, and of how many when known. */
export interface DownloadProgress {
  received: number;
  total?: number;
}

const H = {
  item: 'x-mossgoblin-item',
  feed: 'x-mossgoblin-feed',
  title: 'x-mossgoblin-title',
  published: 'x-mossgoblin-published',
  source: 'x-mossgoblin-source',
  auto: 'x-mossgoblin-auto',
} as const;

/** How long an automatic download that failed waits before it is tried again. */
const RETRY_MS = 60 * 60 * 1000;

class OverCap extends Error {}

/** "12.3 MB", "640 KB", for the Downloads list (#180). */
export function size(bytes: number): string {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / MB;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Offline downloads of podcast episodes (#180, epic #177). An episode
 * is fetched whole through the Worker's `/api/episode` proxy with the
 * gardener's ID token, same-origin, and kept in the Cache Storage
 * under that link; sw.js answers the player's byte ranges from it, so
 * it plays and seeks offline. The cache is the record: each response
 * carries the item's id, feed, title and date in headers, so the
 * Downloads list needs nothing else.
 *
 * The cap (Settings, Downloads) holds the total: a download by hand makes
 * room by removing the oldest downloads, by date published, never the
 * episode in hand. A podcast set to keep its newest N gets them
 * downloaded as its episodes arrive, into the room under the cap only,
 * and its automatic downloads past those N go. Automatic downloads
 * wait for Wi-Fi where the browser says what the connection is, unless
 * the gardener turned that off; a tap on Download does not wait.
 */
@Injectable({ providedIn: 'root' })
export class DownloadsService {
  private readonly api = inject(DOWNLOADS_API);
  private readonly auth = inject(AuthService);
  private readonly items = inject(ItemsService);
  private readonly prefs = inject(DownloadPrefs);
  private readonly presence = inject(PlayerPresence);
  private readonly online = inject(ONLINE);

  private readonly records = signal<DownloadRecord[]>([]);
  private readonly read = signal(false);
  /** Automatic downloads that failed, by item id, with when. */
  private readonly failed = new Map<string, number>();
  private syncing?: Promise<void>;
  private again = false;

  /** Whether this browser has the Cache Storage (a secure context does). */
  readonly available = signal(true);
  /** Whether the cache has been read once. */
  readonly loaded = computed(() => this.read());
  /** The downloads, newest episode first. */
  readonly list = computed(() =>
    [...this.records()].sort((a, b) => b.published - a.published || a.id.localeCompare(b.id)),
  );
  /** Bytes kept, all told. */
  readonly total = computed(() => this.records().reduce((sum, r) => sum + r.bytes, 0));
  /** Downloads under way, by item id. */
  readonly progress = signal<Record<string, DownloadProgress>>({});
  private readonly ids = computed(() => new Set(this.records().map((r) => r.id)));

  constructor() {
    void this.scan();
    // New episodes, or a podcast's N changed: keep the newest downloaded.
    effect(() => {
      this.items.items();
      this.prefs.keep();
      if (!this.read() || !this.items.loaded()) return;
      untracked(() => void this.sync());
    });
    // A lower cap: the oldest go until the rest fit.
    effect(() => {
      const cap = this.prefs.capBytes();
      if (!this.read()) return;
      untracked(() => {
        if (this.total() > cap) void this.makeRoom(0, undefined);
      });
    });
  }

  has(id: string): boolean {
    return this.ids().has(id);
  }

  record(id: string): DownloadRecord | undefined {
    return this.records().find((r) => r.id === id);
  }

  /**
   * The link the player plays an episode from: the proxy's, which the
   * service worker answers from the cache, once it is downloaded; the
   * enclosure's own until then.
   */
  source(item: ItemRecord): string | undefined {
    const kept = this.record(item.id);
    if (kept) return episodePath(kept.url);
    return item.enclosure?.url;
  }

  /** Whether automatic downloads may start now: online, and on Wi-Fi when that is asked for. */
  mayDownload(): boolean {
    return this.online() && (!this.prefs.wifiOnly() || onWifi(this.api.connection()));
  }

  /**
   * Downloads an episode by hand, on any connection. Undefined once it
   * is kept, or a message saying why not.
   */
  async download(item: ItemRecord): Promise<string | undefined> {
    if (!item.enclosure) return 'That is not an episode.';
    if (this.has(item.id) || this.progress()[item.id]) return undefined;
    if (!this.available()) return 'This browser cannot keep downloads.';
    // A tap is the gardener's choice: the Wi-Fi rule is for automatic ones.
    if (!this.online()) return 'Downloading needs the network.';
    return this.fetchInto(item, false);
  }

  /** Removes a download. */
  async remove(id: string): Promise<void> {
    const kept = this.record(id);
    if (!kept) return;
    this.records.update((l) => l.filter((r) => r.id !== id));
    try {
      const cache = await this.api.open();
      await cache.delete(episodePath(kept.url));
    } catch (err) {
      console.error('download not removed', err);
    }
  }

  /**
   * Forgets a download whose cached file is gone (the browser may evict
   * it), so the player and the list stop offering it (review on #192).
   */
  async forgetIfGone(id: string): Promise<void> {
    const kept = this.record(id);
    if (!kept) return;
    try {
      const cache = await this.api.open();
      if (await cache.match(episodePath(kept.url))) return;
    } catch {
      // No cache to read: nothing is kept in it either.
    }
    this.records.update((l) => l.filter((r) => r.id !== id));
  }

  /** Resolves once any automatic downloads under way are done, for specs. */
  async settled(): Promise<void> {
    while (this.syncing) await this.syncing;
  }

  /** Reads what the cache holds. */
  private async scan(): Promise<void> {
    try {
      const cache = await this.api.open();
      const found: DownloadRecord[] = [];
      for (const key of await cache.keys()) {
        const res = await cache.match(key.url);
        const id = res?.headers.get(H.item);
        if (!res || !id) continue;
        const stated = Number(res.headers.get('content-length'));
        const bytes = stated > 0 ? stated : (await res.blob()).size;
        found.push({
          id,
          feedId: res.headers.get(H.feed) ?? '',
          title: decodeURIComponent(res.headers.get(H.title) ?? ''),
          published: Number(res.headers.get(H.published)) || 0,
          url: decodeURIComponent(res.headers.get(H.source) ?? ''),
          bytes,
          auto: res.headers.get(H.auto) === '1',
        });
      }
      // Anything downloaded while this read was under way stays.
      this.records.update((l) => [...found.filter((f) => !l.some((r) => r.id === f.id)), ...l]);
    } catch (err) {
      console.error('downloads not read', err);
      this.available.set(false);
    } finally {
      this.read.set(true);
    }
  }

  /**
   * Keeps each podcast's newest N unplayed episodes downloaded, one at
   * a time, into the room under the cap; its automatic downloads past
   * those N go, never the episode in hand.
   */
  private sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.again = false;
        await this.syncOnce();
      } while (this.again);
    })().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const keep = this.prefs.keep();
    const inHand = this.presence.id();
    const queue: ItemRecord[] = [];
    for (const [feedId, n] of Object.entries(keep)) {
      if (n <= 0) continue;
      const newest = this.items
        .items()
        .filter((i) => i.feedId === feedId && i.enclosure && !i.played)
        .slice(0, n);
      for (const ep of newest) {
        if (!this.has(ep.id)) queue.push(ep);
      }
    }
    // An automatic download goes once its podcast keeps none, it is
    // played, or N newer unplayed episodes are at hand; one whose item
    // is not at hand (a listener still loading) stays until then.
    const episodes = this.items.items().filter((i) => i.enclosure);
    for (const r of this.records()) {
      if (!r.auto || r.id === inHand) continue;
      const n = keep[r.feedId] ?? 0;
      const newer = episodes.filter(
        (i) => i.feedId === r.feedId && !i.played && i.published > r.published,
      ).length;
      if (n <= 0 || episodes.find((i) => i.id === r.id)?.played || newer >= n) {
        await this.remove(r.id);
      }
    }
    if (!this.available() || !this.mayDownload()) return;
    queue.sort((a, b) => b.published - a.published);
    const now = Date.now();
    for (const ep of queue) {
      if (this.has(ep.id) || this.progress()[ep.id]) continue;
      if (now - (this.failed.get(ep.id) ?? -Infinity) < RETRY_MS) continue;
      if (!this.mayDownload()) return;
      const why = await this.fetchInto(ep, true);
      if (why) this.failed.set(ep.id, now);
    }
  }

  /**
   * Fetches an episode through the proxy and keeps it. By hand, room
   * is made under the cap; automatically, only the room there is is
   * used. Undefined once kept, or why not.
   */
  private async fetchInto(item: ItemRecord, auto: boolean): Promise<string | undefined> {
    const enclosure = item.enclosure!;
    const user = this.auth.user();
    if (!user) return 'Sign in first.';
    const path = episodePath(enclosure.url);
    const cap = this.prefs.capBytes();
    const capText = `${this.prefs.capMb()} MB`;
    const controller = new AbortController();
    this.setProgress(item.id, { received: 0, total: enclosure.bytes });
    try {
      const token = await user.getIdToken();
      const res = await this.api.fetch(path, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok || !res.body) {
        void res.body?.cancel();
        return res.status === 401
          ? 'Sign in again to download.'
          : res.status === 415
            ? 'That link is not audio.'
            : res.status === 413
              ? 'That episode is too big to download.'
              : 'Could not download it. Try again later.';
      }
      const stated = Number(res.headers.get('content-length')) || undefined;
      const expected = stated ?? enclosure.bytes;
      if (expected !== undefined && expected > cap) {
        controller.abort();
        return `That episode is bigger than the ${capText} kept for downloads.`;
      }
      if (expected !== undefined) {
        const fits = auto ? this.total() + expected <= cap : await this.makeRoom(expected, item.id);
        if (!fits) {
          controller.abort();
          return `No room under the ${capText} kept for downloads.`;
        }
      }
      // A file that states no size is stopped where the room ends.
      const limit = auto ? cap - this.total() : cap;
      let received = 0;
      let shown = 0;
      const counted = res.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, out) => {
            received += chunk.byteLength;
            if (received > limit) {
              out.error(new OverCap());
              return;
            }
            out.enqueue(chunk);
            if (received - shown >= 256 * 1024) {
              shown = received;
              this.setProgress(item.id, { received, total: stated ?? enclosure.bytes });
            }
          },
        }),
      );
      const headers = new Headers({
        'content-type': res.headers.get('content-type') ?? 'audio/mpeg',
        [H.item]: item.id,
        [H.feed]: item.feedId,
        [H.title]: encodeURIComponent(item.title),
        [H.published]: String(item.published),
        [H.source]: encodeURIComponent(enclosure.url),
        [H.auto]: auto ? '1' : '0',
      });
      if (stated) headers.set('content-length', String(stated));
      const cache = await this.api.open();
      await cache.put(path, new Response(counted, { headers }));
      this.records.update((l) => [
        ...l.filter((r) => r.id !== item.id),
        {
          id: item.id,
          feedId: item.feedId,
          title: item.title,
          published: item.published,
          url: enclosure.url,
          bytes: stated ?? received,
          auto,
        },
      ]);
      if (!auto && this.total() > cap) await this.makeRoom(0, item.id);
      return undefined;
    } catch (err) {
      if (err instanceof OverCap || (err as { cause?: unknown })?.cause instanceof OverCap) {
        return `No room under the ${capText} kept for downloads.`;
      }
      console.error('episode not downloaded', err);
      return 'Could not download it. Are you online?';
    } finally {
      this.progress.update((p) => {
        const next = { ...p };
        delete next[item.id];
        return next;
      });
    }
  }

  /**
   * Removes the oldest downloads, by date published, until `bytes` more
   * fit under the cap, never the episode in hand or `except`; whether
   * they fit. When they cannot fit even so, a new download removes
   * nothing; a lower cap removes what it can.
   */
  private async makeRoom(bytes: number, except: string | undefined): Promise<boolean> {
    const cap = this.prefs.capBytes();
    const inHand = this.presence.id();
    const oldest = [...this.records()]
      .filter((r) => r.id !== inHand && r.id !== except)
      .sort((a, b) => a.published - b.published);
    const fixed = this.total() - oldest.reduce((sum, r) => sum + r.bytes, 0);
    if (bytes > 0 && fixed + bytes > cap) return false;
    for (const r of oldest) {
      if (this.total() + bytes <= cap) break;
      await this.remove(r.id);
    }
    return this.total() + bytes <= cap;
  }

  private setProgress(id: string, p: DownloadProgress): void {
    this.progress.update((all) => ({ ...all, [id]: p }));
  }
}
