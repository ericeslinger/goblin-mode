// What happens to a file once it lands in Storage (#44): its bytes are
// checked against its declared type, and an image gets a thumbnail its
// record names. Over a small store interface, so it runs in specs
// without Storage (storage-store.ts is the real one).
import { SNIFF_BYTES, isDeclared, sniffType } from '@mossgoblin/schema';

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
  /** Corrects a file's stored content type to what its bytes are. */
  setContentType(path: string, contentType: string): Promise<void>;
  /** Sets the attachment record's `thumbPath`, if the record is there. */
  setThumb(uid: string, id: string, thumbPath: string): Promise<void>;
  /** Deletes an attachment's record (its files go with it). */
  removeRecord(uid: string, id: string): Promise<void>;
}

/** Shrinks an image to a thumbnail, or throws for one it cannot read. */
export type Thumbnailer = (bytes: Uint8Array) => Promise<Uint8Array>;

export type UploadOutcome = 'thumbnailed' | 'kept' | 'removed' | 'skipped';

/** Object metadata that marks a thumbnail this function wrote. */
export const THUMB_METADATA = { mossgoblinThumbnail: 'true' };

/**
 * A file landed. Bytes that are none of the types the app keeps (HTML or
 * SVG labelled a photo) are removed with the attachment's record. Bytes
 * that are, but not the declared one (a WebP saved as .jpg, which a
 * browser labels by its name), are kept and relabelled. A photo then
 * gets a thumbnail its record names.
 */
export async function processUpload(
  store: UploadStore,
  thumbnail: Thumbnailer,
  path: string,
  contentType: string | undefined,
  metadata: Record<string, string> | undefined,
  warn: (message: string, detail?: unknown) => void = () => undefined,
): Promise<UploadOutcome> {
  const place = placeOf(path);
  // Not an attachment, or a thumbnail this function wrote (marked by
  // metadata only it sets, not by a name an upload could take).
  if (!place) return 'skipped';
  if (place.name.startsWith(THUMB_PREFIX) && metadata?.['mossgoblinThumbnail'] === 'true') {
    return 'skipped';
  }
  const head = await store.head(path, SNIFF_BYTES);
  const actual = sniffType(head);
  if (!actual) {
    warn('removed a file that is not a photo or PDF', { path, contentType });
    await store.remove(path);
    await store.removeRecord(place.uid, place.id);
    return 'removed';
  }
  if (!isDeclared(head, contentType)) {
    warn('relabelled a file by its bytes', { path, contentType, actual });
    await store.setContentType(path, actual);
  }
  if (!actual.startsWith('image/')) return 'kept';
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
