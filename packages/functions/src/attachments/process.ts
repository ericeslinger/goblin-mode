// What happens to a file once it lands in Storage (#44): its bytes are
// checked against its declared type, and an image gets a thumbnail its
// record names. Over a small store interface, so it runs in specs
// without Storage (storage-store.ts is the real one).
import { SNIFF_BYTES, isDeclared } from './sniff';

/** Where an attachment's file sits: users/{uid}/attachments/{id}/{name}. */
export interface FilePlace {
  uid: string;
  id: string;
  name: string;
}

/** The prefix for thumbnails, beside the file they shrink. */
export const THUMB_PREFIX = 'thumb_';
/** A thumbnail's longest side, in pixels. */
export const THUMB_SIZE = 640;

export function placeOf(path: string): FilePlace | undefined {
  const m = /^users\/([^/]+)\/attachments\/([^/]+)\/([^/]+)$/.exec(path);
  return m ? { uid: m[1], id: m[2], name: m[3] } : undefined;
}

export function thumbPathFor(place: FilePlace): string {
  const base = place.name.replace(/\.[A-Za-z0-9]+$/, '');
  return `users/${place.uid}/attachments/${place.id}/${THUMB_PREFIX}${base}.webp`;
}

export interface UploadStore {
  /** The first `n` bytes of a file. */
  head(path: string, n: number): Promise<Uint8Array>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Sets the attachment record's `thumbPath`, if the record is there. */
  setThumb(uid: string, id: string, thumbPath: string): Promise<void>;
}

/** Shrinks an image to a thumbnail, or throws for one it cannot read. */
export type Thumbnailer = (bytes: Uint8Array) => Promise<Uint8Array>;

export type UploadOutcome = 'thumbnailed' | 'kept' | 'removed' | 'skipped';

export async function processUpload(
  store: UploadStore,
  thumbnail: Thumbnailer,
  path: string,
  contentType: string | undefined,
  warn: (message: string, detail?: unknown) => void = () => undefined,
): Promise<UploadOutcome> {
  const place = placeOf(path);
  // Not an attachment, or a thumbnail this function wrote.
  if (!place || place.name.startsWith(THUMB_PREFIX)) return 'skipped';
  if (!isDeclared(await store.head(path, SNIFF_BYTES), contentType)) {
    warn('removed a file that is not what it says', { path, contentType });
    await store.remove(path);
    return 'removed';
  }
  if (!contentType?.startsWith('image/')) return 'kept';
  try {
    const thumb = await thumbnail(await store.read(path));
    const thumbPath = thumbPathFor(place);
    await store.write(thumbPath, thumb, 'image/webp');
    await store.setThumb(place.uid, place.id, thumbPath);
    return 'thumbnailed';
  } catch (err) {
    // HEIC, which the image library cannot decode, shows full size.
    warn('no thumbnail', { path, err: String(err) });
    return 'kept';
  }
}
