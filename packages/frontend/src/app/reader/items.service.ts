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
import {
  UNCATEGORIZED,
  byQueue,
  clippingBody,
  isQueueOrder,
  isWebLink,
  orderAfter,
  orderAt,
  orderBefore,
  paths,
  renumber,
} from '@mossgoblin/schema';
import {
  type Firestore,
  Timestamp,
  collection,
  deleteField,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { type Functions, httpsCallable } from 'firebase/functions';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import { NOW, SESSION_STORAGE } from '../platform/platform';
import { ReadingService } from '../reading/reading.service';
import { ReaderService, callableMessage } from './reader.service';
import { ALL, SAVED, type Shelf2, shelfParam } from './shelves';

export { ALL, RESERVED_FOLDERS, SAVED, type Shelf2, shelfParam } from './shelves';

/** The newest unread articles the app listens to; the rest come as these are read. */
export const UNREAD_LIMIT = 1000;
/** Recently read articles kept at hand, for Show read and undo. */
export const READ_LIMIT = 200;
/** Articles opened from a search that no shelf holds, kept at hand at most (#175). */
const OPENED_MAX = 20;
/**
 * Each show's newest episodes the app listens to (#245), read or not,
 * so one whose notes were read stays at hand until it is heard.
 */
export const EPISODES_PER_SHOW = 100;
/** The listening queue's episodes the app listens to at most (#249). */
export const QUEUE_LIMIT = 500;

/** A podcast episode's audio (#178), as the fetcher stored it. */
export interface EnclosureRecord {
  url: string;
  type: string;
  bytes?: number;
  seconds?: number;
}

/** An article as the app shows it (#162). */
export interface ItemRecord {
  id: string;
  feedId: string;
  title: string;
  link: string;
  author?: string;
  /** Milliseconds. */
  published: number;
  summary: string;
  content: string;
  read: boolean;
  saved: boolean;
  /** The reading-queue record Save for later made (#163). */
  attachmentId?: string;
  /** The clipping File in the garden made (#163). */
  noteId?: string;
  readerState?: 'requested' | 'working' | 'done' | 'failed';
  readerContent?: string;
  readerError?: string;
  /** An episode's audio, artwork and number (#178); an item with audio is an episode. */
  enclosure?: EnclosureRecord;
  image?: string;
  episode?: number;
  /** The Feedly boards it was on (#176), as the import kept them. */
  tags?: string[];
  /** Where the episode was left, in seconds (#179). */
  position?: number;
  /** When that was, milliseconds, the server's clock once it has the write. */
  playedAt?: number;
  /** Heard to the end (#179). */
  played?: boolean;
  /** Its place in the listening queue (#249), ascending; absent when not queued. */
  queue?: number;
}

const isWeb = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//i.test(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The enclosure as stored, when it is one (#178). */
function toEnclosure(v: unknown): EnclosureRecord | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const e = v as Record<string, unknown>;
  if (!isWeb(e['url'])) return undefined;
  return {
    url: e['url'],
    type: typeof e['type'] === 'string' ? e['type'] : '',
    ...(isNum(e['bytes']) ? { bytes: e['bytes'] } : {}),
    ...(isNum(e['seconds']) ? { seconds: e['seconds'] } : {}),
  };
}

/** Which articles a listener follows. */
export type Shelf = 'unread' | 'read' | 'saved';

/** The Firestore calls the service makes, as a seam for unit specs. */
export interface ItemsApi {
  listen(
    db: Firestore,
    path: string,
    shelf: Shelf,
    next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    error: (err: unknown) => void,
  ): () => void;
  set(db: Firestore, path: string, data: Record<string, unknown>): Promise<void>;
  /** Several merges in one batch, for Mark all read and read on scroll. */
  setMany(db: Firestore, writes: { path: string; data: Record<string, unknown> }[]): Promise<void>;
  serverTime(): unknown;
  /** A timestamp made on the device from epoch millis (#179: playedAt). */
  timestamp(ms: number): unknown;
  clear(): unknown;
  /** One show's newest episodes, read or not (#245), newest first. */
  listenFeed(
    db: Firestore,
    path: string,
    feedId: string,
    next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    error: (err: unknown) => void,
  ): () => void;
  /**
   * One show's episodes older than `before` (millis), newest first, at
   * most `count` (#246, Show older episodes): a one-time read through
   * the cache, by the index the listener uses.
   */
  pageFeed(
    db: Firestore,
    path: string,
    feedId: string,
    /** Published at or before this instant: the caller drops what it holds. */
    before: number,
    count: number,
  ): Promise<{ id: string; data: Record<string, unknown> }[]>;
  /** The fetchArticle callable (#163): the page's article kept on the item. */
  fetchArticle(itemId: string): Promise<{ state: string }>;
  /**
   * The listening queue (#249): every item with a `queue`, ascending
   * (`orderBy('queue')` holds only the items that have one), whatever
   * each show's newest hundred holds.
   */
  listenQueue(
    db: Firestore,
    path: string,
    next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    error: (err: unknown) => void,
  ): () => void;
  /** One article's document (#175), for one search found that no shelf holds; undefined when gone. */
  listenOne(
    db: Firestore,
    path: string,
    next: (data: Record<string, unknown> | undefined) => void,
    error: (err: unknown) => void,
  ): () => void;
}

export const ITEMS_API = new InjectionToken<ItemsApi>('items-api', {
  providedIn: 'root',
  factory: () => {
    const { functions } = inject(FIREBASE);
    return itemsApi(functions);
  },
});

function itemsApi(functions: Functions): ItemsApi {
  return {
    fetchArticle: async (itemId) =>
      (await httpsCallable<unknown, { state: string }>(functions, 'fetchArticle')({ itemId })).data,
    listen: (db, path, shelf, next, error) => {
      const items = collection(db, path);
      const q =
        shelf === 'unread'
          ? query(
              items,
              where('read', '==', false),
              orderBy('published', 'desc'),
              limit(UNREAD_LIMIT),
            )
          : shelf === 'read'
            ? query(items, where('read', '==', true), orderBy('readAt', 'desc'), limit(READ_LIMIT))
            : query(
                items,
                where('saved', '==', true),
                orderBy('published', 'desc'),
                limit(UNREAD_LIMIT),
              );
      return onSnapshot(
        q,
        (snap) =>
          next(
            snap.docs.map((d) => ({ id: d.id, data: d.data({ serverTimestamps: 'estimate' }) })),
          ),
        error,
      );
    },
    listenFeed: (db, path, feedId, next, error) =>
      onSnapshot(
        query(
          collection(db, path),
          where('feedId', '==', feedId),
          orderBy('published', 'desc'),
          limit(EPISODES_PER_SHOW),
        ),
        (snap) =>
          next(
            snap.docs.map((d) => ({ id: d.id, data: d.data({ serverTimestamps: 'estimate' }) })),
          ),
        error,
      ),
    pageFeed: async (db, path, feedId, before, count) =>
      (
        await getDocs(
          query(
            collection(db, path),
            where('feedId', '==', feedId),
            where('published', '<=', Timestamp.fromMillis(before)),
            orderBy('published', 'desc'),
            limit(count),
          ),
        )
      ).docs.map((d) => ({ id: d.id, data: d.data({ serverTimestamps: 'estimate' }) })),
    listenQueue: (db, path, next, error) =>
      onSnapshot(
        query(collection(db, path), orderBy('queue'), limit(QUEUE_LIMIT)),
        (snap) =>
          next(
            snap.docs.map((d) => ({ id: d.id, data: d.data({ serverTimestamps: 'estimate' }) })),
          ),
        error,
      ),
    listenOne: (db, path, next, error) =>
      onSnapshot(
        doc(db, path),
        (snap) => next(snap.exists() ? snap.data({ serverTimestamps: 'estimate' }) : undefined),
        error,
      ),
    set: (db, path, data) => setDoc(doc(db, path), data, { merge: true }),
    setMany: async (db, writes) => {
      for (let at = 0; at < writes.length; at += 400) {
        const batch = writeBatch(db);
        for (const w of writes.slice(at, at + 400))
          batch.set(doc(db, w.path), w.data, { merge: true });
        await batch.commit();
      }
    },
    serverTime: () => serverTimestamp(),
    timestamp: (ms) => Timestamp.fromMillis(ms),
    clear: () => deleteField(),
  };
}

function toItem(id: string, d: Record<string, unknown>): ItemRecord {
  const at = (d['published'] as { toMillis?: () => number } | undefined)?.toMillis?.();
  const enclosure = toEnclosure(d['enclosure']);
  const playedAt = (d['playedAt'] as { toMillis?: () => number } | undefined)?.toMillis?.();
  return {
    id,
    feedId: String(d['feedId'] ?? ''),
    title: String(d['title'] ?? ''),
    link: typeof d['link'] === 'string' ? d['link'] : '',
    ...(typeof d['author'] === 'string' && d['author'] ? { author: d['author'] } : {}),
    published: at ?? 0,
    summary: String(d['summary'] ?? ''),
    content: String(d['content'] ?? ''),
    read: d['read'] === true,
    saved: d['saved'] === true,
    ...(Array.isArray(d['tags']) && d['tags'].length
      ? { tags: d['tags'].filter((t): t is string => typeof t === 'string') }
      : {}),
    ...(typeof d['attachmentId'] === 'string' ? { attachmentId: d['attachmentId'] } : {}),
    ...(typeof d['noteId'] === 'string' ? { noteId: d['noteId'] } : {}),
    ...(['requested', 'working', 'done', 'failed'].includes(String(d['readerState']))
      ? { readerState: d['readerState'] as ItemRecord['readerState'] }
      : {}),
    ...(typeof d['readerContent'] === 'string' ? { readerContent: d['readerContent'] } : {}),
    ...(typeof d['readerError'] === 'string' ? { readerError: d['readerError'] } : {}),
    ...(enclosure ? { enclosure } : {}),
    ...(isWeb(d['image']) ? { image: d['image'] } : {}),
    ...(isNum(d['episode']) ? { episode: d['episode'] } : {}),
    ...(isNum(d['position']) && d['position'] >= 0 ? { position: d['position'] } : {}),
    ...(isNum(playedAt) ? { playedAt } : {}),
    ...(d['played'] === true ? { played: true } : {}),
    ...(isQueueOrder(d['queue']) ? { queue: d['queue'] } : {}),
  };
}

const NONE: ReadonlySet<string> = new Set();
/** Where the visited articles are kept for this tab, through a reload (#188). */
export const VISITED_KEY = 'goblin.reader.visited';

/**
 * The articles (#162): the newest thousand unread, the last two hundred
 * read and everything saved, each a listener through the persistent
 * cache, filtered by folder on the device. Marks are written at once,
 * offline too; the listeners move the article between shelves.
 */
@Injectable({ providedIn: 'root' })
export class ItemsService {
  private readonly auth = inject(AuthService);
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(ITEMS_API);
  private readonly feeds = inject(ReaderService);
  private readonly now = inject(NOW);
  private readonly modules = inject(ModulesService);
  private readonly notes = inject(NotesService);
  private readonly reading = inject(ReadingService);

  private readonly unreadDocs = signal<ItemRecord[]>([]);
  private readonly readDocs = signal<ItemRecord[]>([]);
  private readonly savedDocs = signal<ItemRecord[]>([]);
  private readonly read = signal(false);
  /** Marks made here before the listeners echo them, by id. */
  private readonly local = signal<
    Record<
      string,
      Partial<
        Pick<
          ItemRecord,
          'read' | 'saved' | 'attachmentId' | 'noteId' | 'played' | 'position' | 'queue'
        >
      >
    >
  >({});
  /** Each show's newest episodes (#245), by feed id. */
  private readonly episodeDocs = signal<Record<string, ItemRecord[]>>({});
  private episodeStops = new Map<string, () => void>();
  private episodesUid?: string;
  /**
   * A show's older episodes (#246), the pages Show older episodes
   * loaded past its newest hundred, by feed id, newest first; `done`
   * once a page came back short. Read once, not listened to, and kept
   * until signed out or the show leaves Podcasts.
   */
  private readonly olderDocs = signal<Record<string, { docs: ItemRecord[]; done: boolean }>>({});
  /** The listening queue's episodes (#249), as its listener has them. */
  private readonly queueDocs = signal<ItemRecord[]>([]);

  /**
   * The articles opened on one shelf in this sitting, by its
   * `shelfParam` (#188): read now, but still in the article's sequence
   * for the way back, whichever article page opens them next (back
   * from the caught-up page, say). Another shelf starts afresh. Kept
   * in this tab's sessionStorage too, so a reload still has them.
   */
  private readonly session = inject(SESSION_STORAGE);
  private readonly visited = signal<{ shelf: string; ids: ReadonlySet<string> }>(
    this.storedVisits(),
  );

  /**
   * Articles opened that no shelf holds (#175): a search can find one
   * read long ago, past the two hundred kept at hand. One listener
   * each, by id, through the persistent cache; never counted on a shelf.
   */
  private readonly openedDocs = signal<Record<string, ItemRecord>>({});
  private opened = new Map<string, () => void>();

  /** Whether the unread shelf has been read once, so empty means caught up. */
  readonly loaded = computed(() => this.read());

  /** Every article at hand, by id, newest first, local marks applied. */
  readonly items = computed(() => {
    const local = this.local();
    const byId = new Map<string, ItemRecord>();
    // The queue's episodes (#249) are only the shows' in Podcasts: one
    // of a show moved to the Reader keeps its place, unseen, until it
    // is moved back.
    const podcasts = this.podcastIds();
    for (const list of [
      this.queueDocs().filter((i) => podcasts.has(i.feedId)),
      this.unreadDocs(),
      this.readDocs(),
      this.savedDocs(),
      ...Object.values(this.episodeDocs()),
    ]) {
      for (const i of list) byId.set(i.id, { ...i, ...local[i.id] });
    }
    return [...byId.values()].sort((a, b) => b.published - a.published);
  });

  /**
   * The Reader's articles (#245): every item at hand but the episodes
   * of the shows in Podcasts, which no shelf, count or line of the
   * Reader's holds.
   */
  readonly readerItems = computed(() => {
    const podcasts = this.podcastIds();
    return this.items().filter((i) => !podcasts.has(i.feedId));
  });

  /** The episodes of the shows in Podcasts (#245), newest first. */
  readonly episodes = computed(() => {
    const podcasts = this.podcastIds();
    return this.items().filter((i) => podcasts.has(i.feedId));
  });

  /**
   * The listening queue (#249): the episodes of the shows in Podcasts
   * that have a place in it, in its order (ascending, ties by id), local
   * changes applied at once.
   */
  readonly queue = computed(() =>
    this.episodes()
      .filter((i): i is ItemRecord & { queue: number } => !!i.enclosure && isQueueOrder(i.queue))
      .sort(byQueue),
  );
  private readonly queuedIds = computed(() => new Set(this.queue().map((i) => i.id)));

  /**
   * Continue listening (#179), in the Reader: its own items with audio
   * left part-way, on any device, the most recently played first. The
   * shows in Podcasts have Started there instead (#245).
   */
  readonly listening = computed(() =>
    this.readerItems()
      .filter((i) => i.enclosure && !i.played && (i.position ?? 0) > 0)
      .sort((a, b) => (b.playedAt ?? 0) - (a.playedAt ?? 0)),
  );

  /** Unread articles per folder name, the special folders included. */
  readonly unreadCounts = computed(() => {
    const counts: Record<string, number> = { [ALL]: 0, [SAVED]: 0 };
    const folders = this.foldersOf();
    for (const i of this.readerItems()) {
      if (i.saved) counts[SAVED] = (counts[SAVED] ?? 0) + (i.read ? 0 : 1);
      if (i.read) continue;
      counts[ALL]++;
      for (const f of folders.get(i.feedId) ?? [UNCATEGORIZED]) counts[f] = (counts[f] ?? 0) + 1;
    }
    return counts;
  });

  /** The ids of the shows in Podcasts (#245), the same list while it is the same. */
  private readonly podcastIdList = computed(
    () =>
      this.feeds
        .podcastFeeds()
        .map((f) => f.id)
        .sort(),
    { equal: (a, b) => a.length === b.length && a.every((id, n) => id === b[n]) },
  );
  private readonly podcastIds = computed(() => new Set(this.podcastIdList()));

  /**
   * Folders with unread articles newer than when their list was last
   * opened (#173), for Right Now: every unread one in a folder never
   * opened. Most first, then by name; none with nothing new.
   */
  readonly newSince = computed(() => {
    const seen = this.feeds.seenAt();
    const folders = this.foldersOf();
    const counts = new Map<string, number>();
    for (const i of this.readerItems()) {
      if (i.read) continue;
      for (const f of folders.get(i.feedId) ?? [UNCATEGORIZED]) {
        const at = seen[f];
        if (at === undefined || i.published > at) counts.set(f, (counts.get(f) ?? 0) + 1);
      }
    }
    return [...counts]
      .map(([folder, count]) => ({ folder, count }))
      .sort(
        (a, b) =>
          b.count - a.count || a.folder.localeCompare(b.folder, undefined, { sensitivity: 'base' }),
      );
  });

  private readonly foldersOf = computed(() => {
    const map = new Map<string, string[]>();
    for (const f of this.feeds.feeds())
      map.set(f.id, f.folders.length ? f.folders : [UNCATEGORIZED]);
    return map;
  });

  private uid?: string;
  private stops: (() => void)[] = [];
  /** The account the listeners are for: none while the Reader and Podcasts are both off. */
  private readonly listenAs = computed(() =>
    this.modules.reader() || this.modules.podcasts() ? this.auth.user()?.uid : undefined,
  );

  constructor() {
    // Each show's newest episodes (#245), a listener per show, started
    // and stopped as shows are followed, moved and unfollowed.
    effect(() => {
      const uid = this.listenAs();
      const ids = this.podcastIdList();
      untracked(() => this.followEpisodes(uid, ids));
    });
    effect(() => {
      const uid = this.listenAs();
      if (uid === this.uid) return;
      for (const stop of this.stops) stop();
      this.stops = [];
      this.queueDocs.set([]);
      const was = this.uid;
      for (const stop of this.opened.values()) stop();
      this.opened.clear();
      this.openedDocs.set({});
      this.uid = uid;
      this.unreadDocs.set([]);
      this.readDocs.set([]);
      this.savedDocs.set([]);
      this.local.set({});
      // Signed out (or the Reader off): this tab forgets them. Not on
      // the first sign-in, which would drop what a reload kept.
      if (was !== undefined) this.forgetVisits();
      this.read.set(false);
      if (!uid) return;
      const path = paths.feedItems(uid);
      const shelves: [Shelf, (list: ItemRecord[]) => void][] = [
        ['unread', (l) => (this.unreadDocs.set(l), this.read.set(true))],
        ['read', (l) => this.readDocs.set(l)],
        ['saved', (l) => this.savedDocs.set(l)],
      ];
      // The listening queue (#249): its own listener, so the queue is
      // whole whatever each show's newest hundred holds.
      this.stops.push(
        this.api.listenQueue(
          this.fb.db,
          path,
          (docs) => {
            this.queueDocs.set(docs.map((d) => toItem(d.id, d.data)));
            this.local.update((l) => {
              const next = { ...l };
              for (const d of docs) delete next[d.id];
              return next;
            });
          },
          (err) => console.error('queue listener', err),
        ),
      );
      for (const [shelf, set] of shelves) {
        this.stops.push(
          this.api.listen(
            this.fb.db,
            path,
            shelf,
            (docs) => {
              set(docs.map((d) => toItem(d.id, d.data)));
              // The echo carries this device's marks: drop the local copy.
              this.local.update((l) => {
                const next = { ...l };
                for (const d of docs) delete next[d.id];
                return next;
              });
            },
            (err) => console.error(`${shelf} articles listener`, err),
          ),
        );
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.stops.forEach((s) => s());
      this.opened.forEach((s) => s());
      this.episodeStops.forEach((s) => s());
    });
  }

  private followEpisodes(uid: string | undefined, ids: readonly string[]): void {
    if (uid !== this.episodesUid) {
      for (const stop of this.episodeStops.values()) stop();
      this.episodeStops.clear();
      this.episodeDocs.set({});
      this.olderDocs.set({});
      this.episodesUid = uid;
    }
    if (!uid) return;
    const want = new Set(ids);
    for (const [id, stop] of this.episodeStops) {
      if (want.has(id)) continue;
      stop();
      this.episodeStops.delete(id);
      this.episodeDocs.update(({ [id]: _, ...rest }) => rest);
      this.olderDocs.update(({ [id]: _, ...rest }) => rest);
    }
    for (const id of ids) {
      if (this.episodeStops.has(id)) continue;
      this.episodeStops.set(
        id,
        this.api.listenFeed(
          this.fb.db,
          paths.feedItems(uid),
          id,
          (docs) => {
            this.episodeDocs.update((d) => ({
              ...d,
              [id]: docs.map((doc) => toItem(doc.id, doc.data)),
            }));
            this.local.update((l) => {
              const next = { ...l };
              for (const doc of docs) delete next[doc.id];
              return next;
            });
          },
          (err) => console.error('episodes listener', err),
        ),
      );
    }
  }

  /**
   * The articles on a shelf: a folder (All and Saved included) or one
   * feed; never an episode of a show in Podcasts (#245).
   */
  inShelf(shelf: Shelf2, showRead: boolean): ItemRecord[] {
    const folders = this.foldersOf();
    return this.readerItems().filter((i) => {
      if (shelf.kind === 'feed') {
        if (i.feedId !== shelf.id) return false;
      } else if (shelf.name === SAVED) {
        if (!i.saved) return false;
        return true;
      } else if (shelf.name !== ALL) {
        if (!(folders.get(i.feedId) ?? [UNCATEGORIZED]).includes(shelf.name)) return false;
      }
      return showRead || !i.read;
    });
  }

  /** Notes an article opened on a shelf (#188); another shelf than the last starts a fresh set. */
  visit(shelf: Shelf2, id: string): void {
    const key = shelfParam(shelf);
    // Untracked: the article page calls this from an effect.
    const v = untracked(this.visited);
    if (v.shelf === key && v.ids.has(id)) return;
    const ids = v.shelf === key ? [...v.ids, id] : [id];
    this.visited.set({ shelf: key, ids: new Set(ids) });
    try {
      this.session?.setItem(VISITED_KEY, JSON.stringify({ shelf: key, ids }));
    } catch {
      // Storage refused: they last until a reload.
    }
  }

  /** What this tab kept, read once as the service is made; nothing when storage throws. */
  private storedVisits(): { shelf: string; ids: ReadonlySet<string> } {
    try {
      const raw = this.session?.getItem(VISITED_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : undefined;
      if (v && typeof v === 'object') {
        const { shelf, ids } = v as { shelf?: unknown; ids?: unknown };
        if (typeof shelf === 'string' && Array.isArray(ids)) {
          return { shelf, ids: new Set(ids.filter((i): i is string => typeof i === 'string')) };
        }
      }
    } catch {
      // Unreadable or refused: start afresh.
    }
    return { shelf: '', ids: NONE };
  }

  private forgetVisits(): void {
    this.visited.set({ shelf: '', ids: NONE });
    try {
      this.session?.removeItem(VISITED_KEY);
    } catch {
      // Storage refused: nothing more to do.
    }
  }

  /** The articles opened on a shelf in this sitting (#188). */
  visitedIn(shelf: Shelf2): ReadonlySet<string> {
    const v = this.visited();
    return v.shelf === shelfParam(shelf) ? v.ids : NONE;
  }

  /**
   * A show's older episodes loaded on its page (#246), past the newest
   * hundred its listener holds, newest first, local marks applied.
   */
  olderEpisodes(feedId: string): ItemRecord[] {
    const local = this.local();
    const held = new Set((this.episodeDocs()[feedId] ?? []).map((i) => i.id));
    return (this.olderDocs()[feedId]?.docs ?? [])
      .filter((i) => !held.has(i.id))
      .map((i) => ({ ...i, ...local[i.id] }));
  }

  /**
   * Whether a show may have episodes older than those at hand (#246):
   * its listener came back full, and no older page has come back short.
   */
  mayHaveOlder(feedId: string): boolean {
    const listened = this.episodeDocs()[feedId]?.length ?? 0;
    return listened >= EPISODES_PER_SHOW && !this.olderDocs()[feedId]?.done;
  }

  /**
   * Show older episodes (#246): the next hundred of a show's episodes
   * before the oldest at hand, read once by its feed and date. How
   * many came, or a message saying why none could be read.
   */
  async loadOlder(feedId: string): Promise<number | string> {
    const uid = this.episodesUid;
    if (!uid) return 'Sign in first.';
    const at = [...(this.episodeDocs()[feedId] ?? []), ...(this.olderDocs()[feedId]?.docs ?? [])];
    if (!at.length) return 0;
    const oldest = Math.min(...at.map((i) => i.published));
    // Episodes can share an instant: the page starts at the oldest at
    // hand, not before it, asks for that many more, and drops the ones
    // already held, so a run of them is never cut (review on #250).
    const held = new Set(at.map((i) => i.id));
    const want = EPISODES_PER_SHOW + at.filter((i) => i.published === oldest).length;
    let docs;
    try {
      docs = await this.api.pageFeed(this.fb.db, paths.feedItems(uid), feedId, oldest, want);
    } catch (err) {
      console.error('older episodes not read', err);
      return 'Could not load older episodes. Are you online?';
    }
    // Signed out, or the show gone, while the page was on its way.
    if (uid !== this.episodesUid || !this.episodeStops.has(feedId)) return 0;
    const page = docs.map((d) => toItem(d.id, d.data)).filter((i) => !held.has(i.id));
    this.olderDocs.update((o) => ({
      ...o,
      [feedId]: {
        docs: [...(o[feedId]?.docs ?? []), ...page],
        done: docs.length < want,
      },
    }));
    return page.length;
  }

  find(id: string): ItemRecord | undefined {
    const shelved = this.items().find((i) => i.id === id);
    if (shelved) return shelved;
    for (const { docs } of Object.values(this.olderDocs())) {
      const older = docs.find((i) => i.id === id);
      if (older) return { ...older, ...this.local()[id] };
    }
    const opened = this.openedDocs()[id];
    return opened && { ...opened, ...this.local()[id] };
  }

  /**
   * Fetches an article no shelf holds (#175), one a search found, so
   * it opens as any other does; it stays at hand while signed in. At
   * most twenty such, the first opened let go first.
   */
  open(id: string): void {
    const uid = this.uid;
    if (!uid || !id || this.opened.has(id) || this.items().some((i) => i.id === id)) return;
    if (this.opened.size >= OPENED_MAX) {
      const [first, stop] = this.opened.entries().next().value!;
      stop();
      this.opened.delete(first);
      this.openedDocs.update(({ [first]: _, ...rest }) => rest);
    }
    this.opened.set(
      id,
      this.api.listenOne(
        this.fb.db,
        paths.feedItem(uid, id),
        (data) => {
          this.openedDocs.update(({ [id]: _, ...rest }) =>
            data ? { ...rest, [id]: toItem(id, data) } : rest,
          );
          // The echo carries this device's marks, as a shelf's does.
          this.local.update(({ [id]: _, ...rest }) => rest);
        },
        (err) => console.error('article listener', err),
      ),
    );
  }

  /** Marks one read (now) or unread again. */
  setRead(id: string, read: boolean): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    this.local.update((l) => ({ ...l, [id]: { ...l[id], read } }));
    void this.api
      .set(this.fb.db, paths.feedItem(uid, id), {
        read,
        readAt: read ? this.api.serverTime() : this.api.clear(),
        updatedAt: this.api.serverTime(),
      })
      .catch((err) => console.error('read mark not saved', err));
  }

  /**
   * Keeps where an episode was left (#179), in one merge through the
   * persistent cache, offline too: the position in seconds and when.
   * Heard to the end, it is also marked played and read, in a merge of
   * its own without playedAt, so the rules' check on playedAt (#190)
   * can refuse the place but never the played mark.
   *
   * When is the device's clock at the write, not the server's at the
   * sync (Eric, 2026-11-07: client timestamps for conflicting update
   * times), so a place kept offline and synced late stays as old as it
   * is. Returns that time in millis, for the player's `seenAt`; nothing
   * when signed out and nothing is written.
   */
  setProgress(id: string, progress: { position: number; played?: boolean }): number | undefined {
    const uid = this.auth.user()?.uid;
    if (!uid) return undefined;
    const position = Math.max(0, Number.isFinite(progress.position) ? progress.position : 0);
    const at = this.now();
    const path = paths.feedItem(uid, id);
    if (progress.played) {
      // Heard to the end, it leaves the listening queue (#249).
      const queued = this.queued(id);
      this.local.update((l) => ({
        ...l,
        [id]: { ...l[id], read: true, ...(queued ? { queue: undefined } : {}) },
      }));
      void this.api
        .set(this.fb.db, path, {
          played: true,
          read: true,
          readAt: this.api.serverTime(),
          ...(queued ? { queue: this.api.clear() } : {}),
          updatedAt: this.api.serverTime(),
        })
        .catch((err) => console.error('played mark not saved', err));
    }
    void this.api
      .set(this.fb.db, path, {
        position,
        playedAt: this.api.timestamp(at),
        ...(progress.played ? {} : { played: false }),
        updatedAt: this.api.serverTime(),
      })
      .catch((err) => console.error('listening position not saved', err));
    return at;
  }

  /**
   * Mark as heard, or Mark as new (#245): heard is `played`; new
   * clears it and the place kept, so the episode is New again. Neither
   * touches `read`, which is whether its notes were read. Heard also
   * takes it off the listening queue (#249).
   */
  setPlayed(id: string, played: boolean): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    const leaves = played && this.queued(id);
    this.local.update((l) => ({
      ...l,
      [id]: {
        ...l[id],
        played,
        ...(played ? {} : { position: undefined }),
        ...(leaves ? { queue: undefined } : {}),
      },
    }));
    void this.api
      .set(this.fb.db, paths.feedItem(uid, id), {
        played,
        ...(played ? {} : { position: this.api.clear() }),
        ...(leaves ? { queue: this.api.clear() } : {}),
        updatedAt: this.api.serverTime(),
      })
      .catch((err) => console.error('heard mark not saved', err));
  }

  /**
   * Mark all as heard (#246, a show's More): `played` on each of these
   * episodes in one batch through the persistent cache, never awaited,
   * shown at once; returns how many. `read` and the place are left;
   * the queued ones leave the listening queue, as Mark as heard does
   * (#249).
   */
  setPlayedMany(ids: string[]): number {
    const uid = this.auth.user()?.uid;
    if (!uid || !ids.length) return 0;
    const queued = this.queuedIds();
    this.local.update((l) => {
      const next = { ...l };
      for (const id of ids) {
        next[id] = { ...next[id], played: true, ...(queued.has(id) ? { queue: undefined } : {}) };
      }
      return next;
    });
    void this.api
      .setMany(
        this.fb.db,
        ids.map((id) => ({
          path: paths.feedItem(uid, id),
          data: {
            played: true,
            ...(queued.has(id) ? { queue: this.api.clear() } : {}),
            updatedAt: this.api.serverTime(),
          },
        })),
      )
      .catch((err) => console.error('heard marks not saved', err));
    return ids.length;
  }

  /** Whether an episode is in the listening queue (#249). */
  queued(id: string): boolean {
    return this.queuedIds().has(id);
  }

  /**
   * Add to the queue (#249): at its end, a step after the last and never
   * before now (`orderAfter`), so two devices appending offline keep
   * the order they appended in. Through the cache, never awaited, shown
   * at once. In the queue already, it stays where it is.
   */
  addToQueue(id: string): void {
    if (this.queued(id)) return;
    this.placeInQueue(id, orderAfter(this.queue().at(-1)?.queue, this.now()));
  }

  /** Play next (#249): a step before the first of the others, so it is next up. */
  playNext(id: string): void {
    const first = this.queue().find((i) => i.id !== id)?.queue;
    this.placeInQueue(id, orderBefore(first, this.now()));
  }

  /** Remove from the queue (#249): its place cleared, nothing else. */
  removeFromQueue(id: string): void {
    if (!this.queued(id)) return;
    this.placeInQueue(id, undefined);
  }

  /**
   * A move in the queue (#249), by the drag, a grip's arrows or More:
   * `order` is the list as shown after the move (Up next, which leaves
   * out the one playing), so `id` takes the midpoint of its new
   * neighbours there, or a step past the end it went to. When the
   * neighbours are too close for a midpoint, the whole queue is
   * renumbered in one batch, the moved one after its new neighbour.
   */
  moveInQueue(id: string, order: readonly string[]): void {
    const queue = this.queue();
    const by = new Map(queue.map((i) => [i.id, i.queue]));
    if (!by.has(id)) return;
    const shown = order.filter((x) => by.has(x));
    const at = shown.indexOf(id);
    if (at < 0) return;
    const others = shown.filter((x) => x !== id).map((x) => by.get(x)!);
    const value = orderAt(others, at, this.now());
    if (value !== undefined) return this.placeInQueue(id, value);
    const rest = queue.map((i) => i.id).filter((x) => x !== id);
    const before = shown[at - 1];
    rest.splice(
      before === undefined ? rest.indexOf(shown[at + 1]) : rest.indexOf(before) + 1,
      0,
      id,
    );
    const values = renumber(rest.length, queue[0].queue);
    this.renumberQueue(rest.map((x, n) => [x, values[n]]));
  }

  /** One episode's place in the queue written, or cleared with undefined. */
  private placeInQueue(id: string, queue: number | undefined): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    this.local.update((l) => ({ ...l, [id]: { ...l[id], queue } }));
    void this.api
      .set(this.fb.db, paths.feedItem(uid, id), {
        queue: queue === undefined ? this.api.clear() : queue,
        updatedAt: this.api.serverTime(),
      })
      .catch((err) => console.error('queue place not saved', err));
  }

  /** The whole queue's new places, in one batch through the cache (#249). */
  private renumberQueue(places: [string, number][]): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    this.local.update((l) => {
      const next = { ...l };
      for (const [id, queue] of places) next[id] = { ...next[id], queue };
      return next;
    });
    void this.api
      .setMany(
        this.fb.db,
        places.map(([id, queue]) => ({
          path: paths.feedItem(uid, id),
          data: { queue, updatedAt: this.api.serverTime() },
        })),
      )
      .catch((err) => console.error('queue not renumbered', err));
  }

  /** "12:34", or "1:02:03" past the hour, for the player (#179). */
  clock(seconds: number): string {
    const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  /**
   * Saves one for later, or unsaves it. Saving also puts its link in the
   * reading queue (#163), once, so the server fetches the page's text
   * and search_attachments finds it; unsaving leaves that record.
   */
  setSaved(id: string, saved: boolean): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    const item = this.find(id);
    const attachmentId =
      saved && item && !item.attachmentId && item.link ? this.reading.save(item.link) : undefined;
    this.local.update((l) => ({
      ...l,
      [id]: { ...l[id], saved, ...(attachmentId ? { attachmentId } : {}) },
    }));
    void this.api
      .set(this.fb.db, paths.feedItem(uid, id), {
        saved,
        ...(attachmentId ? { attachmentId } : {}),
        // A saved article is kept past the keep-for months (#171).
        ...(saved ? { expireAt: this.api.clear() } : {}),
        updatedAt: this.api.serverTime(),
      })
      .catch((err) => console.error('save mark not saved', err));
  }

  /**
   * Files an article in the garden (#163): a note of kind clipping, made
   * at once and offline, tied to the item. Filed already: that note.
   */
  fileInGarden(id: string): string | undefined {
    const uid = this.auth.user()?.uid;
    const item = this.find(id);
    if (!uid || !item) return undefined;
    if (item.noteId) return item.noteId;
    const feed = this.feeds.feeds().find((f) => f.id === item.feedId);
    // Only a web link is kept, in the body and in `source` (review on #168).
    const link = isWebLink(item.link) ? item.link : '';
    const body = clippingBody({
      title: item.title,
      link,
      feedTitle: feed?.title ?? '',
      ...(item.author ? { author: item.author } : {}),
      published: item.published,
      content: item.readerContent || item.content,
    });
    const noteId = this.notes.clip(body, item.title, {
      ...(link ? { url: link } : {}),
      feedItemId: id,
    });
    this.local.update((l) => ({ ...l, [id]: { ...l[id], noteId } }));
    void this.api
      .set(this.fb.db, paths.feedItem(uid, id), {
        noteId,
        expireAt: this.api.clear(),
        updatedAt: this.api.serverTime(),
      })
      .catch((err) => console.error('clipping not tied', err));
    return noteId;
  }

  /**
   * Reader mode (#163): asks the server for the page's article, kept on
   * the item; the listener shows it when it lands. Needs the network;
   * the message says why not, otherwise undefined.
   */
  async readerMode(id: string): Promise<string | undefined> {
    if (!this.auth.user()?.uid) return 'Sign in first.';
    try {
      await this.api.fetchArticle(id);
      return undefined;
    } catch (err) {
      const message = callableMessage(err);
      return /Could not fetch|used up|Already fetching/.test(message)
        ? message
        : 'Could not fetch the page. Are you online?';
    }
  }

  /**
   * Notes a folder's list as opened now (#173), so its articles stop
   * counting as new in Right Now. Nothing is written when nothing in it
   * is newer than the last time. The time kept is never before its
   * newest article, so one dated ahead by a feed's clock is seen too.
   */
  markSeen(folder: string): void {
    const newest = this.inShelf({ kind: 'folder', name: folder }, false)[0]?.published;
    if (newest === undefined) return;
    const seen = this.feeds.seenAt()[folder];
    if (seen !== undefined && newest <= seen) return;
    this.feeds.markSeen(folder, Math.max(this.now(), newest));
  }

  /** Marks every unread article at hand on a shelf read; returns how many. */
  markAllRead(shelf: Shelf2): number {
    // Only the unread: Saved shows read ones too (review on #167).
    const ids = this.inShelf(shelf, false)
      .filter((i) => !i.read)
      .map((i) => i.id);
    return this.setReadMany(ids, true);
  }

  /**
   * Marks several read (now) or unread again in one batch, shown at
   * once; returns how many. Mark all read and mark read on scroll and
   * its Undo (#172) go through here.
   */
  setReadMany(ids: string[], read: boolean): number {
    const uid = this.auth.user()?.uid;
    if (!uid || !ids.length) return 0;
    this.local.update((l) => {
      const next = { ...l };
      for (const id of ids) next[id] = { ...next[id], read };
      return next;
    });
    void this.api
      .setMany(
        this.fb.db,
        ids.map((id) => ({
          path: paths.feedItem(uid, id),
          data: {
            read,
            readAt: read ? this.api.serverTime() : this.api.clear(),
            updatedAt: this.api.serverTime(),
          },
        })),
      )
      .catch((err) => console.error('read marks not saved', err));
    return ids.length;
  }

  /** An episode's length for its row (#178): "42 min", "1 h 05 min", never "0 min". */
  duration(seconds: number): string {
    const min = Math.max(1, Math.round(seconds / 60));
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const rest = min % 60;
    return rest ? `${h} h ${String(rest).padStart(2, '0')} min` : `${h} h`;
  }

  /** "3 min ago", "yesterday", "Nov 2", for a row. */
  age(published: number): string {
    const diff = this.now() - published;
    const min = Math.floor(diff / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7) return `${d} days ago`;
    return new Date(published).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}
