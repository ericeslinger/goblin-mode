// Do it now (#144 step 3): the app asks for a sent note to be done at
// once. onCall, as everything the app asks the server to do is; it only
// writes the run, which the agentRun trigger then drives as the account
// that may open keys. Returns before the run, which can take minutes.
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { RUN_STALE_MS, paths } from '@mossgoblin/schema';
import { firestoreKeyStore } from '../keys/firestore-store';

export const startRun = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = request.auth.uid;
  const noteId = (request.data as { noteId?: unknown } | null)?.noteId;
  if (typeof noteId !== 'string' || !noteId)
    throw new HttpsError('invalid-argument', 'Which note?');
  const db = getFirestore();
  if ((await firestoreKeyStore(db).ciphertext(uid, 'anthropic')) === undefined) {
    throw new HttpsError(
      'failed-precondition',
      'Add an Anthropic key in Settings, AI assistants, to do it now.',
    );
  }
  const runId = db.collection(paths.runs(uid)).doc().id;
  await db.runTransaction(async (tx) => {
    const noteRef = db.doc(paths.note(uid, noteId));
    const note = (await tx.get(noteRef)).data();
    if (!note || note['archived'] === true) throw new HttpsError('not-found', 'No such note.');
    if (note['sendState'] !== 'queued') {
      throw new HttpsError('failed-precondition', 'Send the note to an assistant first.');
    }
    // One run at a time (review on #152): a second device, or a second
    // tap, joins the run going; one lost with its function is replaced.
    const current = typeof note['sendRun'] === 'string' ? note['sendRun'] : undefined;
    if (current) {
      const run = (await tx.get(db.doc(paths.run(uid, current)))).data();
      const since = run?.['startedAt'] ?? run?.['createdAt'];
      const ms = since instanceof Timestamp ? since.toMillis() : 0;
      const live = run?.['status'] === 'requested' || run?.['status'] === 'working';
      if (live && Date.now() - ms < RUN_STALE_MS) {
        throw new HttpsError('already-exists', 'Already doing it now.');
      }
    }
    tx.set(db.doc(paths.run(uid, runId)), {
      kind: 'queued-note',
      noteId,
      sentAt: note['sentAt'],
      status: 'requested',
      steps: [],
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(noteRef, { sendRun: runId });
  });
  return { runId };
});
