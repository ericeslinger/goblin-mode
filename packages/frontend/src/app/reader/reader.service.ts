import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  FEED_CAP,
  type OpmlFeed,
  feedId,
  folderList,
  normalizeFeedUrl,
  parseOpml,
  paths,
} from '@mossgoblin/schema';
import {
  type Firestore,
  collection,
  deleteDoc,
  deleteField,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { type Functions, httpsCallable } from 'firebase/functions';
import { AuthService } from '../auth.service';
import { RESERVED_FOLDERS } from './shelves';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { SETTINGS_API } from '../theme/theme-sync.service';

/** A feed as the app shows it (#159). */
export interface FeedRecord {
  id: string;
  url: string;
  title: string;
  site?: string;
  folders: string[];
  /** Why the fetcher could not read it last time, if it could not. */
  error?: string;
  /** The fetcher has given it up after a month of errors. */
  dead: boolean;
  /** Milliseconds, once the fetcher has looked. */
  fetchedAt?: number;
  /** Set by the fetcher once its items carry audio (#178). */
  kind?: 'podcast';
}

/** What an import did. */
export interface ImportOutcome {
  added: number;
  /** Already followed; new folders from the file were added to them. */
  known: number;
  /** Past the cap, left out. */
  refused: number;
}

/** The Reader's settings as the app holds them; unknown fields ride along. */
interface ReaderSettingsView {
  folderOrder: string[];
  images: boolean;
  keepMonths?: number;
  readOnScroll?: boolean;
  seenAt?: Record<string, unknown>;
}

/** The Reader's settings doc as read. */
function readSettings(data: Record<string, unknown>): ReaderSettingsView {
  const months = data['keepMonths'];
  const seen = data['seenAt'];
  return {
    folderOrder: Array.isArray(data['folderOrder'])
      ? data['folderOrder'].filter((f): f is string => typeof f === 'string')
      : [],
    images: data['images'] !== false,
    ...(typeof months === 'number' && months > 0 ? { keepMonths: months } : {}),
    ...(typeof data['readOnScroll'] === 'boolean' ? { readOnScroll: data['readOnScroll'] } : {}),
    ...(seen && typeof seen === 'object' ? { seenAt: seen as Record<string, unknown> } : {}),
  };
}

/**
 * When each folder's list was last opened (#173), as millis by folder
 * name. The app writes millis; a Timestamp or anything with `toMillis`
 * is read too, and anything else is left out.
 */
function readSeenAt(seen: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [folder, at] of Object.entries(seen ?? {})) {
    const ms =
      typeof at === 'number' ? at : (at as { toMillis?: () => unknown } | null)?.toMillis?.();
    if (typeof ms === 'number' && Number.isFinite(ms)) out[folder] = ms;
  }
  return out;
}

/** The Firestore calls the service makes, as a seam for unit specs. */
export interface ReaderApi {
  listen(
    db: Firestore,
    path: string,
    next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    error: (err: unknown) => void,
  ): () => void;
  set(db: Firestore, path: string, data: Record<string, unknown>, merge: boolean): Promise<void>;
  remove(db: Firestore, path: string): Promise<void>;
  serverTime(): unknown;
  /** The sentinel that clears a field in a merge. */
  clear(): unknown;
  /** The refreshFeeds callable (#161): every feed looked at now. */
  refresh(): Promise<TickReport>;
  /** The applyRetentionNow callable (#171): these keep-for months applied to what is stored. */
  applyRetention(keepMonths: number | null): Promise<{ touched: number }>;
  /** The sweepArticles callable (#171): old unread, unsaved, unfiled articles removed. */
  sweep(): Promise<{ removed: number }>;
  /** The discoverFeeds callable (#174): the feeds at a site's address, with their names. */
  discoverFeeds(url: string): Promise<DiscoveredFeed[]>;
  /** The searchArticles callable (#175): every stored article holding the words, newest first. */
  searchArticles(q: string, limit: number): Promise<SearchOutcome>;
  /** The indexArticles callable (#175): the word index written on the articles stored before it. */
  indexArticles(): Promise<{ indexed: number }>;
}

/**
 * What a search found (#175), and whether the server stopped before it
 * had looked at the oldest articles (review on #197).
 */
export interface SearchOutcome {
  items: SearchHit[];
  truncated?: boolean;
}

/** An article search found (#175), a row's worth: no text. */
export interface SearchHit {
  id: string;
  feedId: string;
  title: string;
  link: string;
  /** Milliseconds. */
  published: number;
  summary: string;
  read: boolean;
  saved: boolean;
  noteId?: string;
}

/** A feed discovery found (#174). */
export interface DiscoveredFeed {
  url: string;
  title: string;
}

/**
 * A callable's error as the server worded it: the Firebase client adds
 * the HTTP status to every message (" [429]"), which is not for the
 * gardener (#174).
 */
export function callableMessage(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message.replace(/ \[\d{3}\]$/, '') : '';
}

/** What a refresh did (`refreshFeeds`, #161). */
export interface TickReport {
  fetched: number;
  added: number;
  failed: number;
  skipped: number;
}

export const READER_API = new InjectionToken<ReaderApi>('reader-api', {
  providedIn: 'root',
  factory: () => {
    // Taken here, in the injection context, not when refresh is called.
    const { functions } = inject(FIREBASE);
    return readerApi(functions);
  },
});

function readerApi(functions: Functions): ReaderApi {
  return {
    refresh: async () =>
      (await httpsCallable<unknown, TickReport>(functions, 'refreshFeeds')({})).data,
    applyRetention: async (keepMonths) =>
      (
        await httpsCallable<unknown, { touched: number }>(
          functions,
          'applyRetentionNow',
        )({ keepMonths })
      ).data,
    sweep: async () =>
      (await httpsCallable<unknown, { removed: number }>(functions, 'sweepArticles')({})).data,
    discoverFeeds: async (url) =>
      (
        await httpsCallable<unknown, { feeds: DiscoveredFeed[] }>(
          functions,
          'discoverFeeds',
        )({ url })
      ).data.feeds,
    searchArticles: async (q, limit) =>
      (
        await httpsCallable<unknown, { items: SearchHit[]; truncated?: boolean }>(
          functions,
          'searchArticles',
        )({ q, limit })
      ).data,
    indexArticles: async () =>
      (await httpsCallable<unknown, { indexed: number }>(functions, 'indexArticles')({})).data,
    clear: () => deleteField(),
    listen: (db, path, next, error) =>
      onSnapshot(
        collection(db, path),
        (snap) =>
          next(
            snap.docs.map((d) => ({ id: d.id, data: d.data({ serverTimestamps: 'estimate' }) })),
          ),
        error,
      ),
    set: (db, path, data, merge) => setDoc(doc(db, path), data, { merge }),
    remove: (db, path) => deleteDoc(doc(db, path)),
    serverTime: () => serverTimestamp(),
  };
}

function toFeed(id: string, d: Record<string, unknown>): FeedRecord {
  const at = (d['fetchedAt'] as { toMillis?: () => number } | undefined)?.toMillis?.();
  return {
    id,
    url: String(d['url'] ?? ''),
    title: String(d['title'] ?? d['url'] ?? ''),
    ...(typeof d['site'] === 'string' ? { site: d['site'] } : {}),
    folders: Array.isArray(d['folders']) ? d['folders'].filter((f) => typeof f === 'string') : [],
    ...(typeof d['error'] === 'string' ? { error: d['error'] } : {}),
    dead: d['dead'] === true,
    ...(at === undefined ? {} : { fetchedAt: at }),
    ...(d['kind'] === 'podcast' ? { kind: 'podcast' as const } : {}),
  };
}

/**
 * A folder name as kept (#185): trimmed, and a name the special shelves
 * use (All, Saved, Podcasts, in any letter case) becomes "<name>
 * (folder)", so the folder shows its own feeds. Renamed, not refused,
 * so an OPML import never loses a feed. Uncategorized is left as it is:
 * it already names the feeds in no folder.
 */
export function cleanFolder(name: string): string {
  const trimmed = name.trim();
  return RESERVED_FOLDERS.includes(trimmed.toLowerCase()) ? `${trimmed} (folder)` : trimmed;
}

/** Folder names as kept: cleaned, blanks dropped, each once. */
function cleanFolders(names: readonly string[]): string[] {
  return [...new Set(names.map(cleanFolder).filter(Boolean))];
}

/**
 * The feeds followed (#159), in folders. Feeds are written through the
 * persistent cache, never awaited, so an import or a move works
 * offline; the fetcher (a function) fills in each feed's state when
 * it reaches the server.
 */
@Injectable({ providedIn: 'root' })
export class ReaderService {
  private readonly auth = inject(AuthService);
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(READER_API);
  private readonly settingsApi = inject(SETTINGS_API);
  private readonly modules = inject(ModulesService);

  private readonly list = signal<FeedRecord[]>([]);
  /** The Reader's own settings doc (`settings/reader`), once read. */
  private readonly settings = signal<ReaderSettingsView | undefined>(undefined);
  /** Whether articles show their images (#162); on until switched off. */
  readonly images = computed(() => this.settings()?.images ?? true);
  /** Months articles are kept unless saved or filed (#171); none keeps everything. */
  readonly keepMonths = computed(() => this.settings()?.keepMonths);
  /** Whether the list marks articles read as they scroll past (#172); off until switched on. */
  readonly readOnScroll = computed(() => this.settings()?.readOnScroll ?? false);
  /** When each folder's list was last opened (#173), millis by name; a folder never opened has none. */
  readonly seenAt = computed(() => readSeenAt(this.settings()?.seenAt));
  /** Whether the settings doc has been read (it may not exist), so a write keeps what it holds. */
  readonly settingsLoaded = computed(() => this.settingsRead());
  private readonly settingsRead = signal(false);
  private readonly read = signal(false);
  readonly feeds = computed(() => this.list());
  /** Whether the feeds have been read, so an empty list means none. */
  readonly loaded = computed(() => this.read());
  /** Folders with their feeds, the gardener's order first, then sorted, Uncategorized last. */
  readonly folders = computed(() => folderList(this.list(), this.settings()?.folderOrder ?? []));
  /** Folder names, for choosing one. */
  readonly folderNames = computed(() => this.folders().map((f) => f.name));

  private uid?: string;
  private stop?: () => void;

  constructor() {
    effect(() => {
      // Nothing is listened to while the module is off (Browse and
      // Settings inject this without needing it then).
      const uid = this.modules.reader() ? this.auth.user()?.uid : undefined;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      this.list.set([]);
      this.read.set(false);
      this.settings.set(undefined);
      this.settingsRead.set(false);
      if (!uid) return;
      const stopSettings = this.settingsApi.listen(
        this.fb.db,
        paths.reader(uid),
        (data) => {
          this.settings.set(data ? readSettings(data) : undefined);
          this.settingsRead.set(true);
        },
        (err) => console.error('reader settings listener', err),
      );
      const stopFeeds = this.api.listen(
        this.fb.db,
        paths.feeds(uid),
        (docs) => {
          this.list.set(docs.map((d) => toFeed(d.id, d.data)));
          this.read.set(true);
        },
        (err) => console.error('feeds listener', err),
      );
      this.stop = () => {
        stopSettings();
        stopFeeds();
      };
    });
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }

  /**
   * Imports an OPML file's feeds: new ones are added in their folders,
   * known ones gain the file's folders, and past the cap the rest are
   * refused. Undefined when the text holds no feeds.
   */
  importOpml(text: string): ImportOutcome | undefined {
    const uid = this.auth.user()?.uid;
    const feeds = parseOpml(text);
    // Before the list is read every feed would look new, and a create
    // replaces a feed's doc, folders and fetch state with it (review on
    // #165): the page keeps Import and Follow off until `loaded`.
    if (!uid || !this.read() || feeds.length === 0) return undefined;
    const outcome: ImportOutcome = { added: 0, known: 0, refused: 0 };
    let count = this.list().length;
    for (const parsed of feeds) {
      const feed = { ...parsed, folders: cleanFolders(parsed.folders) };
      const id = feedId(feed.url);
      const known = this.list().find((f) => f.id === id);
      if (known) {
        outcome.known++;
        const folders = [
          ...known.folders,
          ...feed.folders.filter((f) => !known.folders.includes(f)),
        ];
        if (folders.length !== known.folders.length) this.setFolders(id, folders);
      } else if (count >= FEED_CAP) {
        outcome.refused++;
      } else {
        count++;
        outcome.added++;
        this.create(uid, id, feed);
      }
    }
    return outcome;
  }

  /**
   * Follows one feed by its link, in `folder` if given, named `title`
   * if given (a discovered feed's, #174) or its host until the server
   * looks; returns its id, or undefined when it is no link or the cap
   * is reached. A feed already followed is moved into the folder
   * instead, its name left as it is.
   */
  addFeed(text: string, folder?: string, title?: string): string | undefined {
    const uid = this.auth.user()?.uid;
    const url = normalizeFeedUrl(text);
    if (!uid || !this.read() || !url) return undefined;
    const id = feedId(url);
    const known = this.list().find((f) => f.id === id);
    const folders = cleanFolders(folder ? [folder] : []);
    if (known) {
      if (folders[0] && !known.folders.includes(folders[0])) {
        this.setFolders(id, [...known.folders, folders[0]]);
      }
      return id;
    }
    if (this.list().length >= FEED_CAP) return undefined;
    const name = title?.replace(/\s+/g, ' ').trim().slice(0, 200) || new URL(url).hostname;
    this.create(uid, id, { url, title: name, folders });
    return id;
  }

  /** The feed already followed at this link, if any. */
  followed(text: string): FeedRecord | undefined {
    const url = normalizeFeedUrl(text);
    return url ? this.list().find((f) => f.id === feedId(url)) : undefined;
  }

  /**
   * The feeds at a site's address (#174): a call to the server, which
   * fetches the page and the feeds it names; the candidates, or a
   * message saying why there are none.
   */
  async discover(text: string): Promise<DiscoveredFeed[] | string> {
    if (!this.auth.user()?.uid) return 'Sign in first.';
    const url = normalizeFeedUrl(text);
    if (!url) return 'That is not a link. Paste one starting with https://.';
    try {
      return await this.api.discoverFeeds(url);
    } catch (err) {
      const message = callableMessage(err);
      return /^(No feed found|Could not look at|Today’s \d+ looks)/.test(message)
        ? message
        : 'Could not look. Are you online?';
    }
  }

  /** Puts a feed in these folders (none means Uncategorized). */
  setFolders(id: string, folders: string[]): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    const clean = cleanFolders(folders);
    this.list.update((l) => l.map((f) => (f.id === id ? { ...f, folders: clean } : f)));
    void this.api
      .set(
        this.fb.db,
        paths.feed(uid, id),
        { folders: clean, updatedAt: this.api.serverTime() },
        true,
      )
      .catch((err) => console.error('feed not moved', err));
  }

  /**
   * Every feed looked at now (#161): a call to the server, so it needs
   * the network; the message says what came of it, or why not.
   */
  async refresh(): Promise<string> {
    if (!this.auth.user()?.uid) return 'Sign in first.';
    try {
      const r = await this.api.refresh();
      const feeds = `${r.fetched} ${r.fetched === 1 ? 'feed' : 'feeds'}`;
      const articles = `${r.added} new ${r.added === 1 ? 'article' : 'articles'}`;
      const failed = r.failed ? `, ${r.failed} could not be read` : '';
      return `Looked at ${feeds}: ${articles}${failed}.`;
    } catch (err) {
      const message = callableMessage(err);
      return /Refreshed a moment ago/.test(message)
        ? message
        : 'Could not refresh. Are you online?';
    }
  }

  /**
   * Search across every article stored (#175): a call to the server,
   * which asks the word index, so it needs the network; the articles
   * holding every word, newest first, or a message saying why not.
   * The shelves on the device are not searched apart: one path.
   */
  async search(text: string, limit = 20): Promise<SearchOutcome | string> {
    if (!this.auth.user()?.uid) return 'Sign in first.';
    const q = text.replace(/\s+/g, ' ').trim();
    if (!q) return { items: [], truncated: false };
    try {
      const { items, truncated } = await this.api.searchArticles(q, limit);
      return { items, truncated: truncated === true };
    } catch (err) {
      // The day's searches used up (review on #197) is the server's to say.
      const message = callableMessage(err);
      if (/^Today’s \d+ searches/.test(message)) return message;
      console.error('search failed', err);
      return 'Could not search. Are you online?';
    }
  }

  /** Index articles for search (#175): the ones stored before the index, once a day. */
  async indexArticles(): Promise<string> {
    if (!this.auth.user()?.uid) return 'Sign in first.';
    try {
      const { indexed } = await this.api.indexArticles();
      return `Indexed ${indexed} ${indexed === 1 ? 'article' : 'articles'}.`;
    } catch (err) {
      const message = callableMessage(err);
      return /^Indexed today already/.test(message)
        ? message
        : 'Could not index the articles. Are you online?';
    }
  }

  /** Shows or hides images in articles, for every device. */
  setImages(images: boolean): void {
    this.writeSettings({ images });
  }

  /** Marks articles read as the list scrolls past them, or not (#172), for every device. */
  setReadOnScroll(readOnScroll: boolean): void {
    this.writeSettings({ readOnScroll });
  }

  /**
   * Notes that a folder's list was opened at `at` (#173), so Right Now
   * counts only what is newer. Stored as millis, which the schema's
   * passthrough `seenAt` allows: a plain number reads back the same on
   * every device and in specs, where a server time would not.
   */
  markSeen(folder: string, at: number): void {
    this.writeSettings({ seenAt: { ...this.settings()?.seenAt, [folder]: at } });
  }

  /**
   * Keeps articles for `months` unless saved or filed, or everything
   * when undefined (#171): the setting, then the server applies it to
   * what is stored. The message says what it did, or why not.
   */
  async setKeepMonths(months: number | undefined): Promise<string> {
    this.writeSettings({ keepMonths: months });
    try {
      // The months go with the call: the write above may not have landed yet.
      const { touched } = await this.api.applyRetention(months ?? null);
      return months
        ? `Keeping articles for ${months} months; applied to ${touched} stored ${touched === 1 ? 'article' : 'articles'}.`
        : `Keeping everything; ${touched} ${touched === 1 ? 'article' : 'articles'} will no longer expire.`;
    } catch (err) {
      console.error('retention not applied', err);
      return 'The setting is kept and shapes new articles; choose it again online to apply it to the stored ones.';
    }
  }

  /** Removes the unread, unsaved, unfiled articles older than three months (#171). */
  async sweep(): Promise<string> {
    try {
      const { removed } = await this.api.sweep();
      return `Removed ${removed} old unread ${removed === 1 ? 'article' : 'articles'}.`;
    } catch (err) {
      console.error('sweep failed', err);
      return 'Could not tidy up. Are you online?';
    }
  }

  /** The settings doc written whole, as the rules want it, with the change. */
  private writeSettings(change: Partial<ReaderSettingsView>): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    const current = this.settings() ?? { folderOrder: [], images: true };
    const next: ReaderSettingsView = { ...current, ...change };
    if (next.keepMonths === undefined) delete next.keepMonths;
    this.settings.set(next);
    void this.settingsApi
      .set(this.fb.db, paths.reader(uid), { ...next, updatedAt: this.settingsApi.now() })
      .catch((err) => console.error('reader settings not saved', err));
  }

  /** Asks the fetcher to try a given-up or failing feed again, now. */
  retry(id: string): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    this.list.update((l) =>
      l.map((f) => (f.id === id ? { ...f, dead: false, error: undefined } : f)),
    );
    void this.api
      .set(
        this.fb.db,
        paths.feed(uid, id),
        {
          dead: this.api.clear(),
          error: this.api.clear(),
          errorCount: 0,
          nextFetchAt: this.api.serverTime(),
          updatedAt: this.api.serverTime(),
        },
        true,
      )
      .catch((err) => console.error('feed not retried', err));
  }

  /** Stops following a feed. Its unread articles go with it (#161); saved ones stay. */
  removeFeed(id: string): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    this.list.update((l) => l.filter((f) => f.id !== id));
    void this.api
      .remove(this.fb.db, paths.feed(uid, id))
      .catch((err) => console.error('feed not removed', err));
  }

  private create(uid: string, id: string, feed: OpmlFeed): void {
    const now = this.api.serverTime();
    // Shown at once, before the listener echoes it, so a second import
    // in the same breath sees it as known.
    this.list.update((l) => [...l, { id, ...feed, dead: false }]);
    void this.api
      .set(
        this.fb.db,
        paths.feed(uid, id),
        {
          url: feed.url,
          title: feed.title,
          ...(feed.site ? { site: feed.site } : {}),
          folders: feed.folders,
          addedAt: now,
          updatedAt: now,
          // Due at once: the fetcher looks on its next tick.
          nextFetchAt: now,
        },
        false,
      )
      .catch((err) => console.error('feed not saved', err));
  }
}
