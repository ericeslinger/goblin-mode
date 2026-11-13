import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { claudeTitler, federationFromEnv } from './claude-titler';
import { NoteCodec } from '../mcp/note-text';
import { dataKeyFor } from '../note-keys/client';
import { historyOnWrite, titleOnWrite } from './on-write';
import type { Titler } from './title';
import { firestoreTrashStore, sweepTrash } from './trash';

const NOTE = 'users/{uid}/notes/{noteId}';

/**
 * On every note write: keep the version it replaced, when the rules say
 * so, remember the text it replaced, and merge a write over text its
 * writer had not seen (on-write.ts). A sealed note is opened with one
 * codec for the event; one that cannot be opened here is left as stored.
 */
export const noteHistory = onDocumentWritten(NOTE, async (event) => {
  const { uid, noteId } = event.params;
  await historyOnWrite(
    getFirestore(),
    new NoteCodec(uid, dataKeyFor),
    uid,
    noteId,
    event.id,
    event.data?.before,
    event.data?.after,
    Date.now(),
    logger,
  );
});

let titler: Titler | null | undefined;

/**
 * On every note write: a Claude title when the finished first line
 * changed. Runs as its own Google service account (`goblin-titles`),
 * the identity the Claude federation rule trusts. A sealed body is
 * opened for the model and its title written sealed; a note that cannot
 * be opened here gets no title and is not written (on-write.ts).
 */
export const noteTitle = onDocumentWritten(
  { document: NOTE, serviceAccount: 'goblin-titles@' },
  async (event) => {
    if (titler === undefined) {
      const config = federationFromEnv(process.env);
      titler = config ? claudeTitler(config) : null;
    }
    const { uid, noteId } = event.params;
    const outcome = await titleOnWrite(
      getFirestore(),
      new NoteCodec(uid, dataKeyFor),
      titler,
      uid,
      noteId,
      event.data?.before,
      event.data?.after,
      logger,
    );
    if (outcome !== 'skipped') logger.debug('noteTitle', { noteId, outcome });
  },
);

/**
 * Daily: the notes in Trash 30 days or more go for good, with their
 * History and replaced texts (#217), a batch at a time.
 */
export const trashSweep = onSchedule(
  // A retried run finds only what is left: removing is idempotent.
  { schedule: 'every 24 hours', timeZone: 'UTC', timeoutSeconds: 540 },
  async () => {
    const report = await sweepTrash(firestoreTrashStore(getFirestore()), Date.now());
    if (report.due) logger.info('trashSweep', report);
  },
);
