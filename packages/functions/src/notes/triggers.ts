import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { claudeTitler, federationFromEnv } from './claude-titler';
import { firestoreNotesStore, noteState } from './firestore-store';
import { recordHistory } from './history';
import { type Titler, titleNote } from './title';

const NOTE = 'users/{uid}/notes/{noteId}';

/** On every note write: keep the version it replaced, when the rules say so. */
export const noteHistory = onDocumentWritten(NOTE, async (event) => {
  const { uid, noteId } = event.params;
  const reason = await recordHistory(
    firestoreNotesStore(getFirestore()),
    uid,
    noteId,
    event.id,
    noteState(event.data?.before),
    noteState(event.data?.after),
    Date.now(),
  );
  if (reason) logger.debug('noteHistory kept a version', { noteId, reason });
});

let titler: Titler | null | undefined;

/**
 * On every note write: a Claude title when the finished first line
 * changed. Runs as its own Google service account (`goblin-titles`),
 * the identity the Claude federation rule trusts.
 */
export const noteTitle = onDocumentWritten(
  { document: NOTE, serviceAccount: 'goblin-titles@' },
  async (event) => {
    if (titler === undefined) {
      const config = federationFromEnv(process.env);
      titler = config ? claudeTitler(config) : null;
    }
    const { uid, noteId } = event.params;
    const outcome = await titleNote(
      firestoreNotesStore(getFirestore()),
      titler,
      uid,
      noteId,
      noteState(event.data?.before),
      noteState(event.data?.after),
      (message, err) => logger.warn(message, err),
    );
    if (outcome !== 'skipped') logger.debug('noteTitle', { noteId, outcome });
  },
);
