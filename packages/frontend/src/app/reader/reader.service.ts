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
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';

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
}

/** What an import did. */
export interface ImportOutcome {
  added: number;
  /** Already followed; new folders from the file were added to them. */
  known: number;
  /** Past the cap, left out. */
  refused: number;
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
}

export const READER_API = new InjectionToken<ReaderApi>('reader-api', {
  providedIn: 'root',
  factory: () => ({
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
  }),
});

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
  };
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

  private readonly list = signal<FeedRecord[]>([]);
  private readonly read = signal(false);
  readonly feeds = computed(() => this.list());
  /** Whether the feeds have been read, so an empty list means none. */
  readonly loaded = computed(() => this.read());
  /** Folders with their feeds, sorted, Uncategorized last. */
  readonly folders = computed(() => folderList(this.list()));
  /** Folder names, for choosing one. */
  readonly folderNames = computed(() => this.folders().map((f) => f.name));

  private uid?: string;
  private stop?: () => void;

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      this.list.set([]);
      this.read.set(false);
      if (!uid) return;
      this.stop = this.api.listen(
        this.fb.db,
        paths.feeds(uid),
        (docs) => {
          this.list.set(docs.map((d) => toFeed(d.id, d.data)));
          this.read.set(true);
        },
        (err) => console.error('feeds listener', err),
      );
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
    if (!uid || feeds.length === 0) return undefined;
    const outcome: ImportOutcome = { added: 0, known: 0, refused: 0 };
    let count = this.list().length;
    for (const feed of feeds) {
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
   * Follows one feed by its link, in `folder` if given; returns its id,
   * or undefined when it is no link or the cap is reached. A feed
   * already followed is moved into the folder instead.
   */
  addFeed(text: string, folder?: string): string | undefined {
    const uid = this.auth.user()?.uid;
    const url = normalizeFeedUrl(text);
    if (!uid || !url) return undefined;
    const id = feedId(url);
    const known = this.list().find((f) => f.id === id);
    const folders = folder?.trim() ? [folder.trim()] : [];
    if (known) {
      if (folders[0] && !known.folders.includes(folders[0])) {
        this.setFolders(id, [...known.folders, folders[0]]);
      }
      return id;
    }
    if (this.list().length >= FEED_CAP) return undefined;
    this.create(uid, id, { url, title: new URL(url).hostname, folders });
    return id;
  }

  /** Puts a feed in these folders (none means Uncategorized). */
  setFolders(id: string, folders: string[]): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    const clean = [...new Set(folders.map((f) => f.trim()).filter(Boolean))];
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
