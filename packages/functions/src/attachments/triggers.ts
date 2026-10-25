import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import {
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentWritten,
} from 'firebase-functions/v2/firestore';
import { defineString } from 'firebase-functions/params';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { firestoreKeyStore } from '../keys/firestore-store';
import { sealerFromEnv } from '../keys/sealer';
import { withKey } from '../keys/use';
import { NotesTools } from '../mcp/tools';
import { claudeTranscriber } from './claude-transcriber';
import { importLink, publicFetch } from './import';
import { type Transcriber, transcribe } from './transcribe';
import { processUpload } from './process';
import {
  importStore,
  pdfText,
  prepForClaude,
  removeFiles,
  sharpThumbnail,
  storageStore,
  transcribeStore,
} from './storage-store';

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

/**
 * The account that may open gardeners' keys (decrypt only), and read
 * the photo or PDF; the deploy's IAM gives it those roles and no more.
 */
const RUNNER_ACCOUNT = 'goblin-runner@';

/**
 * Transcribe (#47): when the app asks, Claude reads the photo or PDF and
 * a note of its transcription is written, on the gardener's own
 * Anthropic key (#144 step 2). The key is opened for this one call and
 * the client built from it lives no longer; without a key the request
 * fails with where to add one, and no claim is spent.
 */
export const attachmentTranscribe = onDocumentWritten(
  {
    document: 'users/{uid}/attachments/{attachmentId}',
    serviceAccount: RUNNER_ACCOUNT,
    memory: '1GiB',
    timeoutSeconds: 300,
  },
  async (event) => {
    if (event.data?.after.data()?.['transcribe'] !== 'requested') return;
    const { uid, attachmentId } = event.params;
    const db = getFirestore();
    const keys = firestoreKeyStore(db);
    const keyDeps = { store: keys, sealer: sealerFromEnv(process.env), marks: keys };
    const transcriber: Transcriber | null =
      (await keys.ciphertext(uid, 'anthropic')) === undefined
        ? null
        : (input) =>
            withKey(keyDeps, uid, 'anthropic', 'transcribe', (key) =>
              claudeTranscriber(key)(input),
            );
    const outcome = await transcribe(
      transcribeStore(getStorage().bucket(), db, async (owner, body, title) => {
        const note = await new NotesTools(db, owner).createNote({ body, title });
        return note.id;
      }),
      transcriber,
      prepForClaude,
      uid,
      attachmentId,
      Date.now(),
    );
    logger.info('attachmentTranscribe', { outcome });
  },
);
