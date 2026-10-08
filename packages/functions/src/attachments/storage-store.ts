import { paths } from '@mossgoblin/schema';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import sharp from 'sharp';
import { THUMB_METADATA, THUMB_SIZE, type Thumbnailer, type UploadStore } from './process';

/** The UploadStore over a Storage bucket and Firestore, as the admin SDK. */
export function storageStore(bucket: Bucket, db: Firestore): UploadStore {
  return {
    async head(path, n) {
      const [bytes] = await bucket.file(path).download({ start: 0, end: n - 1 });
      return bytes;
    },
    async read(path) {
      const [bytes] = await bucket.file(path).download();
      return bytes;
    },
    // Only thumbnails are written here, marked so the trigger skips them.
    write: (path, bytes, contentType) =>
      bucket.file(path).save(Buffer.from(bytes), {
        contentType,
        resumable: false,
        metadata: { metadata: THUMB_METADATA },
      }),
    remove: async (path) => void (await bucket.file(path).delete({ ignoreNotFound: true })),
    setContentType: async (path, contentType) =>
      void (await bucket.file(path).setMetadata({ contentType })),
    removeRecord: async (uid, id) =>
      void (await db.doc(`${paths.attachments(uid)}/${id}`).delete()),
    // A merge: the record may not have synced from the phone yet, and
    // the phone's own write merges too, so neither loses the other's.
    setThumb: async (uid, id, thumbPath) =>
      void (await db
        .doc(`${paths.attachments(uid)}/${id}`)
        .set({ thumbPath, updatedAt: FieldValue.serverTimestamp() }, { merge: true })),
  };
}

/** Removes every file of an attachment (its photo and its thumbnail). */
export async function removeFiles(bucket: Bucket, uid: string, id: string): Promise<void> {
  await bucket.deleteFiles({ prefix: `${paths.attachmentFiles(uid, id)}/` });
}

/** A WebP at most THUMB_SIZE on its longer side, turned upright. */
export const sharpThumbnail: Thumbnailer = async (bytes) =>
  sharp(bytes)
    .rotate()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 70 })
    .toBuffer();
