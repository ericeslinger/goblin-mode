import { InjectionToken } from '@angular/core';

/**
 * A file attached on this device and not yet in Storage (#44). Kept in
 * IndexedDB, so a photo taken offline, or before sign-in, survives a
 * reload and uploads when it can: the photo version of "never lose a
 * keystroke".
 */
export interface QueuedUpload {
  id: string;
  /** Storage-safe file name. */
  name: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
  noteId?: string;
  blob: Blob;
  /** Whether its `attachments` record has been written. */
  recorded: boolean;
}

export interface UploadQueue {
  all(): Promise<QueuedUpload[]>;
  put(item: QueuedUpload): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB = 'mossgoblin-uploads';
const STORE = 'uploads';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      // Resolved when the transaction commits, so a put is on disk.
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** The queue over IndexedDB. */
export function indexedDbQueue(): UploadQueue {
  return {
    all: () => run('readonly', (s) => s.getAll() as IDBRequest<QueuedUpload[]>),
    put: async (item) => void (await run('readwrite', (s) => s.put(item))),
    remove: async (id) => void (await run('readwrite', (s) => s.delete(id))),
  };
}

/**
 * The queue in memory, where there is no IndexedDB (some private modes):
 * photos still upload, but one taken offline is lost with the page.
 */
export function memoryQueue(): UploadQueue {
  const items = new Map<string, QueuedUpload>();
  return {
    all: async () => [...items.values()],
    put: async (item) => void items.set(item.id, item),
    remove: async (id) => void items.delete(id),
  };
}

export const UPLOAD_QUEUE = new InjectionToken<UploadQueue>('upload-queue', {
  providedIn: 'root',
  factory: () => (typeof indexedDB === 'undefined' ? memoryQueue() : indexedDbQueue()),
});
