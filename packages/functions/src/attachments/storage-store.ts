import { paths } from '@mossgoblin/schema';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import { dirname } from 'node:path';
import type { ImportStore } from './import';
import type { ImagePrep, TranscribeStore } from './transcribe';
import sharp from 'sharp';
import { THUMB_SIZE, type TextExtractor, type Thumbnailer, type UploadStore } from './process';

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
    // Only files this function makes are written here (thumbnails,
    // extracted text), marked so the trigger skips them.
    write: (path, bytes, contentType, metadata) =>
      bucket.file(path).save(Buffer.from(bytes), {
        contentType,
        resumable: false,
        metadata: { metadata },
      }),
    remove: async (path) => void (await bucket.file(path).delete({ ignoreNotFound: true })),
    setContentType: async (path, contentType) =>
      void (await bucket.file(path).setMetadata({ contentType })),
    removeRecord: async (uid, id) =>
      void (await db.doc(`${paths.attachments(uid)}/${id}`).delete()),
    // A merge: the record may not have synced from the phone yet, and
    // the phone's own write merges too, so neither loses the other's.
    setText: async (uid, id, text) =>
      void (await db
        .doc(`${paths.attachments(uid)}/${id}`)
        .set({ ...text, updatedAt: FieldValue.serverTimestamp() }, { merge: true })),
    setThumb: async (uid, id, thumbPath) =>
      void (await db
        .doc(`${paths.attachments(uid)}/${id}`)
        .set({ thumbPath, updatedAt: FieldValue.serverTimestamp() }, { merge: true })),
  };
}

/** The real store behind link import (#48). */
export function importStore(bucket: Bucket, db: Firestore): ImportStore {
  return {
    write: (path, bytes, contentType, metadata) =>
      bucket.file(path).save(Buffer.from(bytes), {
        contentType,
        resumable: false,
        ...(metadata ? { metadata: { metadata } } : {}),
      }),
    update: async (uid, id, fields) =>
      void (await db
        .doc(`${paths.attachments(uid)}/${id}`)
        .set({ ...fields, updatedAt: FieldValue.serverTimestamp() }, { merge: true })),
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

/**
 * A PDF's text, read by pdf.js (#45): each page's lines, pages apart by
 * a blank line. Loaded only when a PDF arrives.
 */
export const pdfText: TextExtractor = async (bytes) => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    // The 14 standard fonts' metrics, shipped with pdf.js.
    standardFontDataUrl: `${dirname(require.resolve('pdfjs-dist/package.json'))}/standard_fonts/`,
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
          .join('')
          .trim(),
      );
    }
    return { text: pages.join('\n\n'), pages: doc.numPages };
  } finally {
    await task.destroy();
  }
};

/** A photo as Claude reads it well: upright JPEG, at most 2400 px a side. */
export const prepForClaude: ImagePrep = async (bytes) =>
  sharp(bytes)
    .rotate()
    .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

/** The real store behind transcription (#47). */
export function transcribeStore(
  bucket: Bucket,
  db: Firestore,
  writeNote: (uid: string, body: string, title: string) => Promise<string>,
): TranscribeStore {
  return {
    claim: (uid, id, day, cap) =>
      db.runTransaction(async (tx) => {
        const ref = db.doc(`${paths.attachments(uid)}/${id}`);
        const usageRef = db.doc(paths.usage(uid, day));
        const [doc, usage] = await Promise.all([tx.get(ref), tx.get(usageRef)]);
        const record = doc.data();
        if (!record || record['transcribe'] !== 'requested') return { status: 'skip' as const };
        const used = Number(usage.data()?.['transcriptions'] ?? 0);
        if (used >= cap) return { status: 'capped' as const };
        tx.set(usageRef, { transcriptions: used + 1 }, { merge: true });
        tx.set(
          ref,
          {
            transcribe: 'working',
            transcribeStartedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return { status: 'claimed' as const, record };
      }),
    read: async (path) => (await bucket.file(path).download())[0],
    finish: async (uid, id, fields) =>
      void (await db
        .doc(`${paths.attachments(uid)}/${id}`)
        .set({ ...fields, updatedAt: FieldValue.serverTimestamp() }, { merge: true })),
    writeNote,
  };
}
