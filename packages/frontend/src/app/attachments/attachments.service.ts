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
import { type QueuedUpload, UPLOAD_QUEUE, type UploadQueue, memoryQueue } from './upload-queue';

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
  /** Swapped for memory if the device's store fails (quota, private mode). */
  private queue: UploadQueue = inject(UPLOAD_QUEUE);
  private readonly urls$ = inject(OBJECT_URLS);
  /** Object URLs by attachment id: the device's copy, or a download. */
  private readonly urls = new Map<string, string>();
  private readonly loading = new Set<string>();
  /** When a fetch last failed, so redraws do not retry it at once. */
  private readonly failedAt = new Map<string, number>();
  private draining?: Promise<void>;
  /** Failed upload attempts in a row, for the back-off. */
  private failures = 0;
  private retry?: ReturnType<typeof setTimeout>;
  /** Ids attached here and not yet uploaded. */
  readonly waiting = signal<ReadonlySet<string>>(new Set());
  /** Bumped when an image's URL becomes available, so editors redraw. */
  readonly arrived = signal(0);
  /** Uploads have failed a few times running; still being retried. */
  readonly struggling = signal(false);

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
    inject(DestroyRef).onDestroy(() => {
      win?.removeEventListener('online', online);
      clearTimeout(this.retry);
    });
  }

  /** Why `file` cannot be attached, or undefined if it can. */
  check(file: File): string | undefined {
    if (
      !(ATTACHMENT_TYPES as readonly string[]).includes(file.type) ||
      file.type === 'application/pdf'
    ) {
      return 'That file is not a photo this app can keep (JPEG, PNG, WebP, GIF or HEIC).';
    }
    if (file.size > MAX_ATTACHMENT_BYTES) return 'That photo is over 25 MB.';
    return undefined;
  }

  /** A new attachment id, made on the device. */
  newId(): string {
    return this.notes.newId();
  }

  /**
   * Keeps `file` as attachment `id` of note `noteId`: on the device
   * first, then its record, then (when it can) Storage. The caller puts
   * the id in the note before awaiting this, so the photo lands in the
   * note it was taken for. Resolves once the file is safe on the device;
   * rejects only if this device can keep it nowhere.
   */
  async attach(file: File, id: string, noteId?: string): Promise<void> {
    const error = this.check(file);
    if (error) throw new Error(error);
    // Shown at once, while it is stored.
    this.urls.set(id, this.urls$.create(file));
    this.arrived.update((n) => n + 1);
    const item: QueuedUpload = {
      id,
      name: safeName(file.name),
      contentType: file.type,
      size: file.size,
      ...(await imageSize(file)),
      ...(noteId ? { noteId } : {}),
      blob: file,
      recorded: false,
    };
    await this.keep(item);
    this.waiting.update((s) => new Set(s).add(id));
    this.writeRecord(item);
    void this.drain().catch(report);
  }

  /** Into the queue; if the device's store fails, into memory instead. */
  private async keep(item: QueuedUpload): Promise<void> {
    try {
      await this.queue.put(item);
    } catch (err) {
      console.error('could not keep the photo on the device; keeping it in memory', err);
      const queued = await this.queue.all().catch(() => [] as QueuedUpload[]);
      this.queue = memoryQueue();
      for (const q of queued) await this.queue.put(q);
      await this.queue.put(item);
    }
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
    clearTimeout(this.retry);
    let failed = false;
    for (const item of await this.queue.all()) {
      if (!item.recorded) this.writeRecord(item);
      try {
        await this.api.upload(this.filePath(uid, item), item.blob, item.contentType);
      } catch (err) {
        // Kept in the queue, and tried again after a back-off.
        console.error('upload failed', err);
        failed = true;
        continue;
      }
      await this.queue.remove(item.id);
      this.waiting.update((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
    this.failures = failed ? this.failures + 1 : 0;
    this.struggling.set(this.failures >= STRUGGLING_AFTER);
    if (failed) {
      const wait = Math.min(RETRY_MS * 2 ** (this.failures - 1), MAX_RETRY_MS);
      this.retry = setTimeout(() => void this.drain().catch(report), wait);
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

/** How long after a failed fetch or upload it is tried again (doubling). */
const RETRY_MS = 30_000;
const MAX_RETRY_MS = 10 * 60_000;
/** Failed upload rounds in a row before the note says uploads are failing. */
const STRUGGLING_AFTER = 3;

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
