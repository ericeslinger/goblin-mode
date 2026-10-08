import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, paths } from '@mossgoblin/schema';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getBlob, ref, uploadBytes } from 'firebase/storage';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NotesService } from '../notes/notes.service';
import { type QueuedUpload, UPLOAD_QUEUE } from './upload-queue';

/** The Firebase calls attachments make; a seam for specs. */
export interface AttachmentsApi {
  /** Writes an attachment's record (through the offline cache). */
  record(path: string, data: Record<string, unknown>): void;
  /** The Storage path an attachment's record names, if it has one. */
  filePath(path: string): Promise<string | undefined>;
  upload(path: string, blob: Blob, contentType: string): Promise<void>;
  download(path: string): Promise<Blob>;
  serverTime(): unknown;
}

export const ATTACHMENTS_API = new InjectionToken<AttachmentsApi>('attachments-api', {
  providedIn: 'root',
  factory: () => {
    const fb = inject(FIREBASE);
    return {
      record: (path, data) => void setDoc(doc(fb.db, path), data).catch(report),
      filePath: async (path) => {
        const snap = await getDoc(doc(fb.db, path));
        const file = snap.get('path');
        return typeof file === 'string' ? file : undefined;
      },
      upload: async (path, blob, contentType) =>
        void (await uploadBytes(ref(fb.storage, path), blob, { contentType })),
      download: (path) => getBlob(ref(fb.storage, path)),
      serverTime: () => serverTimestamp(),
    };
  },
});

/** Makes object URLs; a seam for specs (happy-dom has none). */
export const OBJECT_URLS = new InjectionToken<{ create(blob: Blob): string }>('object-urls', {
  providedIn: 'root',
  factory: () => ({ create: (blob) => URL.createObjectURL(blob) }),
});

/** A file name Storage paths and rules take: letters, digits, `.`, `-`, `_`. */
export function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '');
  return cleaned.slice(-80) || 'image';
}

/** The caption a new image gets: its file name, without the extension. */
export function captionFor(name: string): string {
  return name.replace(/\.[A-Za-z0-9]+$/, '') || 'image';
}

export type AttachResult = { id: string; caption: string } | { error: string };

/**
 * Images attached to notes (#44). Attaching keeps the file on the
 * device at once (IndexedDB) and writes its record through Firestore's
 * offline cache, so it works with no network; the file uploads when
 * the device is online and signed in. The editor shows the device's
 * copy until then, and a downloaded copy after.
 */
@Injectable({ providedIn: 'root' })
export class AttachmentsService {
  private readonly auth = inject(AuthService);
  private readonly notes = inject(NotesService);
  private readonly api = inject(ATTACHMENTS_API);
  private readonly queue = inject(UPLOAD_QUEUE);
  private readonly urls$ = inject(OBJECT_URLS);
  /** Object URLs by attachment id: the device's copy, or a download. */
  private readonly urls = new Map<string, string>();
  private readonly loading = new Set<string>();
  /** When a fetch last failed, so redraws do not retry it at once. */
  private readonly failedAt = new Map<string, number>();
  private draining?: Promise<void>;
  /** Ids attached here and not yet uploaded. */
  readonly waiting = signal<ReadonlySet<string>>(new Set());
  /** Bumped when an image's URL becomes available, so editors redraw. */
  readonly arrived = signal(0);

  constructor() {
    // Signed in: show what is still queued, and send it.
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid) {
        untracked(
          () =>
            void this.restore()
              .then(() => this.drain())
              .catch(report),
        );
      }
    });
    const win = inject(DOCUMENT).defaultView;
    const online = () => void this.drain().catch(report);
    win?.addEventListener('online', online);
    inject(DestroyRef).onDestroy(() => win?.removeEventListener('online', online));
  }

  /**
   * Keeps `file` for note `noteId`: on the device first, then its
   * record, then (when it can) Storage. Resolves once the file is safe
   * on the device, with the id to put in the note.
   */
  async attach(file: File, noteId?: string): Promise<AttachResult> {
    if (
      !(ATTACHMENT_TYPES as readonly string[]).includes(file.type) ||
      file.type === 'application/pdf'
    ) {
      return {
        error: 'That file is not a photo this app can keep (JPEG, PNG, WebP, GIF or HEIC).',
      };
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return { error: 'That photo is over 25 MB.' };
    }
    const id = this.notes.newId();
    const size = await imageSize(file);
    const item: QueuedUpload = {
      id,
      name: safeName(file.name),
      contentType: file.type,
      size: file.size,
      ...size,
      ...(noteId ? { noteId } : {}),
      blob: file,
      recorded: false,
    };
    await this.queue.put(item);
    this.urls.set(id, this.urls$.create(file));
    this.waiting.update((s) => new Set(s).add(id));
    this.writeRecord(item);
    void this.drain().catch(report);
    return { id, caption: captionFor(file.name) };
  }

  /** The image's URL now, if there is one; otherwise starts fetching it. */
  resolve(id: string): string | undefined {
    const url = this.urls.get(id);
    if (url) return url;
    void this.fetch(id);
    return undefined;
  }

  /** Uploads whatever is queued, once at a time. */
  drain(): Promise<void> {
    this.draining ??= this.send().finally(() => (this.draining = undefined));
    return this.draining;
  }

  private async send(): Promise<void> {
    const uid = this.auth.user()?.uid;
    if (!uid || !navigator.onLine) return;
    for (const item of await this.queue.all()) {
      if (!item.recorded) this.writeRecord(item);
      try {
        await this.api.upload(this.filePath(uid, item), item.blob, item.contentType);
      } catch (err) {
        // Kept in the queue: tried again when back online or next launch.
        console.error('upload failed', err);
        continue;
      }
      await this.queue.remove(item.id);
      this.waiting.update((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  }

  /** The queued files from an earlier visit: shown again, still waiting. */
  private async restore(): Promise<void> {
    const items = await this.queue.all();
    for (const item of items) {
      if (!this.urls.has(item.id)) this.urls.set(item.id, this.urls$.create(item.blob));
    }
    if (items.length) {
      this.waiting.update((s) => new Set([...s, ...items.map((i) => i.id)]));
      this.arrived.update((n) => n + 1);
    }
  }

  private filePath(uid: string, item: Pick<QueuedUpload, 'id' | 'name'>): string {
    return `${paths.attachmentFiles(uid, item.id)}/${item.name}`;
  }

  /** Writes the record once the owner is known; the queue notes it. */
  private writeRecord(item: QueuedUpload): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    const now = this.api.serverTime();
    this.api.record(`${paths.attachments(uid)}/${item.id}`, {
      kind: 'image',
      name: item.name,
      path: this.filePath(uid, item),
      contentType: item.contentType,
      size: item.size,
      ...(item.width !== undefined ? { width: item.width, height: item.height } : {}),
      ...(item.noteId ? { noteId: item.noteId } : {}),
      toRead: false,
      read: false,
      createdAt: now,
      updatedAt: now,
      createdBy: 'user',
    });
    item.recorded = true;
    void this.queue.put(item).catch(report);
  }

  private async fetch(id: string): Promise<void> {
    const uid = this.auth.user()?.uid;
    if (!uid || this.loading.has(id)) return;
    if (Date.now() - (this.failedAt.get(id) ?? -Infinity) < RETRY_MS) return;
    this.loading.add(id);
    try {
      const path = await this.api.filePath(`${paths.attachments(uid)}/${id}`);
      if (!path) throw new Error('no record');
      const blob = await this.api.download(path);
      this.urls.set(id, this.urls$.create(blob));
      this.arrived.update((n) => n + 1);
    } catch (err) {
      // Offline, or not uploaded yet from another device: tried again
      // the next time the note is drawn.
      this.failedAt.set(id, Date.now());
      console.warn('image not available yet', err);
    } finally {
      this.loading.delete(id);
    }
  }
}

/** How long after a failed fetch an image is tried again. */
const RETRY_MS = 30_000;

/** A photo's pixel size, when the browser can decode it (not HEIC everywhere). */
async function imageSize(file: Blob): Promise<{ width?: number; height?: number }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return {};
  }
}

function report(err: unknown): void {
  console.error('attachment write failed', err);
}
