import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { defineString } from 'firebase-functions/params';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { processUpload } from './process';
import { removeFiles, sharpThumbnail, storageStore } from './storage-store';

/**
 * The default bucket's region: a Storage trigger must run where its
 * bucket is (Eric's is us-east1, 2026-10-08), while the other functions
 * stay in us-central1. From the deploy's STORAGE_REGION variable.
 */
const storageRegion = defineString('STORAGE_REGION', { default: 'us-central1' });

/** A file landed: check its bytes, and give a photo a thumbnail (#44). */
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
