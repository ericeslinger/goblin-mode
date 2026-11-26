import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { claudeTitler, federationFromEnv } from './claude-titler';
import { NoteCodec } from '../mcp/note-text';
import { dataKeyFor } from '../note-keys/client';
import { KeptTimes } from './history';
import { historyOnWrite, titleOnWrite } from './on-write';
import type { Titler } from './title';
import { firestoreShareStore, stopSharesOnWrite } from './share-stop';
import { firestoreTrashStore, sweepTrash } from './trash';

const NOTE = 'users/{uid}/notes/{noteId}';

/**
 * When this instance saw versions kept, so a typing save inside the
 * interval reads nothing of History (2026-11-22, history.ts).
 */
const kept = new KeptTimes();

/**
 * On every note write: keep the version it replaced, when the rules say
 * so, remember the text it replaced, and merge a write over text its
 * writer had not seen (on-write.ts). A sealed note is opened with one
 * codec for the event; one that cannot be opened here is left as stored.
 * And a public copy the note no longer stands behind is stopped.
 */
export const noteHistory = onDocumentWritten(NOTE, async (event) => {
  const { uid, noteId } = event.params;
  const db = getFirestore();
  await historyOnWrite(
    db,
    new NoteCodec(uid, dataKeyFor),
    uid,
    noteId,
    event.id,
    event.data?.before,
    event.data?.after,
    Date.now(),
    logger,
    kept,
  );
  // A note in Trash, deleted, or naming another share stops its public
  // copy (2026-11-26, share-stop.ts); the app does too, in the same tap.
  try {
    const stopped = await stopSharesOnWrite(
      firestoreShareStore(db),
      uid,
      noteId,
      event.data?.before?.data(),
      event.data?.after?.data(),
    );
    if (stopped.length)
      logger.info('noteHistory: shares stopped', { noteId, count: stopped.length });
  } catch (err) {
    logger.error('noteHistory: could not stop a share', { noteId, err: String(err) });
  }
});

let titler: Titler | null | undefined;

/**
 * On every note write: a Claude title when a settle asks for one (the
 * note was left after a change, Eric, 2026-10-06) and the text a title
 * is made from is not the one its model title was made from (`titleHash`,
 * 2026-11-22; until then each settle asked, whatever changed). Runs
 * as its own Google service account (`goblin-titles`), the identity
 * the Claude federation rule trusts. A sealed body is
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
    const db = getFirestore();
    const outcome = await titleOnWrite(
      db,
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
