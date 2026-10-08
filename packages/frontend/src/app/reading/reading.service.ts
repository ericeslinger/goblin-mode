import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { autoId, paths } from '@mossgoblin/schema';
import {
  type Firestore,
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NOW, RANDOM_BYTES } from '../platform/platform';

/** A week: what has waited this long unread is mentioned in Right Now. */
export const WAITED_MS = 7 * 24 * 60 * 60 * 1000;

/** Something saved to read later (#48), as the app shows it. */
export interface ReadingItem {
  id: string;
  kind: string;
  name: string;
  url?: string;
  noteId?: string;
  read: boolean;
  /** Milliseconds; undefined while a new one's time is pending. */
  savedAt?: number;
  pages?: number;
  importError?: string;
}

/** The Firestore calls the service makes, as a seam for unit specs. */
export interface ReadingApi {
  listen(
    db: Firestore,
    path: string,
    next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    error: (err: unknown) => void,
  ): () => void;
  set(db: Firestore, path: string, data: Record<string, unknown>, merge: boolean): Promise<void>;
  serverTime(): unknown;
}

export const READING_API = new InjectionToken<ReadingApi>('reading-api', {
  providedIn: 'root',
  factory: () => ({
    listen: (db, path, next, error) =>
      onSnapshot(
        query(collection(db, path), where('toRead', '==', true)),
        (snap) =>
          next(
            snap.docs.map((d) => ({ id: d.id, data: d.data({ serverTimestamps: 'estimate' }) })),
          ),
        error,
      ),
    set: (db, path, data, merge) => setDoc(doc(db, path), data, { merge }),
    serverTime: () => serverTimestamp(),
  }),
});

function toItem(id: string, d: Record<string, unknown>): ReadingItem {
  const at = (d['createdAt'] as { toMillis?: () => number } | undefined)?.toMillis?.();
  return {
    id,
    kind: String(d['kind'] ?? 'link'),
    name: String(d['name'] ?? ''),
    ...(typeof d['url'] === 'string' ? { url: d['url'] } : {}),
    ...(typeof d['noteId'] === 'string' ? { noteId: d['noteId'] } : {}),
    read: d['read'] === true,
    ...(at === undefined ? {} : { savedAt: at }),
    ...(typeof d['pages'] === 'number' ? { pages: d['pages'] } : {}),
    ...(typeof d['importError'] === 'string' ? { importError: d['importError'] } : {}),
  };
}

/** Whether `text` is a link that can be saved: http or https. */
export function linkOf(text: string): URL | undefined {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The reading queue (#48): PDFs and links saved to read later, newest
 * first. Saving a link writes its record at once, offline too; a
 * function fetches its title and text when it reaches the server.
 */
@Injectable({ providedIn: 'root' })
export class ReadingService {
  private readonly auth = inject(AuthService);
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(READING_API);
  private readonly now = inject(NOW);
  private readonly random = inject(RANDOM_BYTES);

  private readonly items = signal<ReadingItem[]>([]);
  /** Newest first. */
  readonly queue = computed(() =>
    [...this.items()].sort((a, b) => (b.savedAt ?? Infinity) - (a.savedAt ?? Infinity)),
  );
  readonly unread = computed(() => this.queue().filter((i) => !i.read));
  /** Unread things saved a week ago or more, for Right Now. */
  readonly waited = computed(() =>
    this.unread().filter((i) => i.savedAt !== undefined && this.now() - i.savedAt >= WAITED_MS),
  );

  private uid?: string;
  private stop?: () => void;

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      this.items.set([]);
      if (!uid) return;
      for (const { id, url } of this.waiting.splice(0)) this.write(uid, id, url);
      this.stop = this.api.listen(
        this.fb.db,
        paths.attachments(uid),
        (docs) => this.items.set(docs.map((d) => toItem(d.id, d.data))),
        (err) => console.error('reading queue listener', err),
      );
    });
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }

  /**
   * Saves a link to read later; returns its id, or undefined if it is no
   * link. While the account is still restoring, it waits here and is
   * written the moment it is known.
   */
  save(text: string): string | undefined {
    const url = linkOf(text);
    if (!url) return undefined;
    const id = autoId(this.random);
    const uid = this.auth.user()?.uid;
    if (uid) this.write(uid, id, url);
    else this.waiting.push({ id, url });
    return id;
  }

  /** Links saved before the account was known. */
  private waiting: { id: string; url: URL }[] = [];

  private write(uid: string, id: string, url: URL): void {
    const now = this.api.serverTime();
    void this.api
      .set(
        this.fb.db,
        `${paths.attachments(uid)}/${id}`,
        {
          kind: 'link',
          name: url.toString(),
          url: url.toString(),
          toRead: true,
          read: false,
          createdAt: now,
          updatedAt: now,
          createdBy: 'user',
        },
        false,
      )
      .catch((err) => console.error('link not saved', err));
  }

  /** Marks one read, or unread again. */
  setRead(id: string, read: boolean): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    void this.api
      .set(
        this.fb.db,
        `${paths.attachments(uid)}/${id}`,
        { read, updatedAt: this.api.serverTime() },
        true,
      )
      .catch((err) => console.error('reading mark not saved', err));
  }
}
