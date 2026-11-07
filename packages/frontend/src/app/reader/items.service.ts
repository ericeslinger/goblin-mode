import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { UNCATEGORIZED, clippingBody, isWebLink, paths } from '@mossgoblin/schema';
import {
  type Firestore,
  collection,
  deleteField,
  doc,
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
import { NOW } from '../platform/platform';
import { ReadingService } from '../reading/reading.service';
import { ReaderService, callableMessage } from './reader.service';

/** The newest unread articles the app listens to; the rest come as these are read. */
export const UNREAD_LIMIT = 1000;
/** Recently read articles kept at hand, for Show read and undo. */
export const READ_LIMIT = 200;

/** The special folders. */
export const ALL = 'all';
export const SAVED = 'saved';

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
  clear(): unknown;
  /** The fetchArticle callable (#163): the page's article kept on the item. */
  fetchArticle(itemId: string): Promise<{ state: string }>;
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
    clear: () => deleteField(),
  };
}

function toItem(id: string, d: Record<string, unknown>): ItemRecord {
  const at = (d['published'] as { toMillis?: () => number } | undefined)?.toMillis?.();
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
    ...(typeof d['attachmentId'] === 'string' ? { attachmentId: d['attachmentId'] } : {}),
    ...(typeof d['noteId'] === 'string' ? { noteId: d['noteId'] } : {}),
    ...(['requested', 'working', 'done', 'failed'].includes(String(d['readerState']))
      ? { readerState: d['readerState'] as ItemRecord['readerState'] }
      : {}),
    ...(typeof d['readerContent'] === 'string' ? { readerContent: d['readerContent'] } : {}),
    ...(typeof d['readerError'] === 'string' ? { readerError: d['readerError'] } : {}),
  };
}

/** A list the reader shows: a folder, one feed, everything, or what is saved. */
export type Shelf2 = { kind: 'folder'; name: string } | { kind: 'feed'; id: string };

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
    Record<string, Partial<Pick<ItemRecord, 'read' | 'saved' | 'attachmentId' | 'noteId'>>>
  >({});

  /** Whether the unread shelf has been read once, so empty means caught up. */
  readonly loaded = computed(() => this.read());

  /** Every article at hand, by id, newest first, local marks applied. */
  readonly items = computed(() => {
    const local = this.local();
    const byId = new Map<string, ItemRecord>();
    for (const list of [this.unreadDocs(), this.readDocs(), this.savedDocs()]) {
      for (const i of list) byId.set(i.id, { ...i, ...local[i.id] });
    }
    return [...byId.values()].sort((a, b) => b.published - a.published);
  });

  /** Unread articles per folder name, the special folders included. */
  readonly unreadCounts = computed(() => {
    const counts: Record<string, number> = { [ALL]: 0, [SAVED]: 0 };
    const folders = this.foldersOf();
    for (const i of this.items()) {
      if (i.saved) counts[SAVED] = (counts[SAVED] ?? 0) + (i.read ? 0 : 1);
      if (i.read) continue;
      counts[ALL]++;
      for (const f of folders.get(i.feedId) ?? [UNCATEGORIZED]) counts[f] = (counts[f] ?? 0) + 1;
    }
    return counts;
  });

  private readonly foldersOf = computed(() => {
    const map = new Map<string, string[]>();
    for (const f of this.feeds.feeds())
      map.set(f.id, f.folders.length ? f.folders : [UNCATEGORIZED]);
    return map;
  });

  private uid?: string;
  private stops: (() => void)[] = [];

  constructor() {
    effect(() => {
      const uid = this.modules.reader() ? this.auth.user()?.uid : undefined;
      if (uid === this.uid) return;
      for (const stop of this.stops) stop();
      this.stops = [];
      this.uid = uid;
      this.unreadDocs.set([]);
      this.readDocs.set([]);
      this.savedDocs.set([]);
      this.local.set({});
      this.read.set(false);
      if (!uid) return;
      const path = paths.feedItems(uid);
      const shelves: [Shelf, (list: ItemRecord[]) => void][] = [
        ['unread', (l) => (this.unreadDocs.set(l), this.read.set(true))],
        ['read', (l) => this.readDocs.set(l)],
        ['saved', (l) => this.savedDocs.set(l)],
      ];
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
    inject(DestroyRef).onDestroy(() => this.stops.forEach((s) => s()));
  }

  /** The articles on a shelf: a folder (All and Saved included) or one feed. */
  inShelf(shelf: Shelf2, showRead: boolean): ItemRecord[] {
    const folders = this.foldersOf();
    return this.items().filter((i) => {
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

  find(id: string): ItemRecord | undefined {
    return this.items().find((i) => i.id === id);
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
