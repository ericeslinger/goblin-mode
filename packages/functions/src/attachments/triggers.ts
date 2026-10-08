import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import { onDocumentCreated, onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { defineString } from 'firebase-functions/params';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { importLink, publicFetch } from './import';
import { processUpload } from './process';
import { importStore, pdfText, removeFiles, sharpThumbnail, storageStore } from './storage-store';

/**
 * The default bucket's region: a Storage trigger must run where its
 * bucket is, while the other functions stay in us-central1. From the
 * deploy's STORAGE_REGION variable (README, Run your own).
 */
const storageRegion = defineString('STORAGE_REGION', { default: 'us-central1' });

/** A file landed: check its bytes, give a photo a thumbnail (#44), read a PDF's text (#45). */
export const attachmentUploaded = onObjectFinalized(
  { memory: '512MiB', region: storageRegion },
  async (event) => {
    const bucket = getStorage().bucket(event.data.bucket);
    const outcome = await processUpload(
      storageStore(bucket, getFirestore()),
      sharpThumbnail,
      event.data.name,
      event.data.contentType,
      event.data.metadata,
      (message, detail) => logger.warn(message, detail),
      pdfText,
    );
    if (outcome !== 'skipped') logger.info('attachmentUploaded', { outcome });
  },
);

/** An attachment's record was deleted: its files go too (review on #43). */
export const attachmentDeleted = onDocumentDeleted(
  'users/{uid}/attachments/{attachmentId}',
  async (event) => {
    const { uid, attachmentId } = event.params;
    await removeFiles(getStorage().bucket(), uid, attachmentId);
  },
);

/** A link saved to read later: fetch its page or PDF (#48). */
export const attachmentCreated = onDocumentCreated(
  { document: 'users/{uid}/attachments/{attachmentId}', memory: '512MiB', timeoutSeconds: 60 },
  async (event) => {
    const record = event.data?.data();
    if (!record) return;
    const { uid, attachmentId } = event.params;
    const outcome = await importLink(
      importStore(getStorage().bucket(), getFirestore()),
      publicFetch,
      uid,
      attachmentId,
      record,
    );
    if (outcome !== 'skipped') logger.info('attachmentCreated', { outcome });
  },
);
