// Asking for a run of the garden's agent on a sent note: Do it now
// (#144 step 3, the startRun callable) and Garden on arrival (#214, the
// noteArrived trigger) both come here, so a run begins the same way
// whoever asked. Refusals are HttpsErrors: startRun passes them to the
// app, the trigger logs them.
import { FieldValue, type Firestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { RUN_STALE_MS, paths } from '@mossgoblin/schema';
import { firestoreKeyStore } from '../keys/firestore-store';
import { DAILY_RUNS, dayOf } from './core';

/** The run a note's arrival starts: one per note, so a settle never sends it twice. */
export const arrivalRunId = (noteId: string) => `arrival-${noteId}`;

/** Fields of a note that say whether its first settle sends it (#214). */
interface NoteFields {
  kind?: unknown;
  body?: unknown;
  archived?: unknown;
  deletedAt?: unknown;
  updatedBy?: unknown;
  sendState?: unknown;
  settledAt?: unknown;
  gardenHold?: unknown;
  fromTemplate?: unknown;
  tags?: unknown;
}

/** What Settings says is never gardened on arrival (#229): template ids and tags. */
export interface ArrivalSkip {
  templates: readonly string[];
  tags: readonly string[];
}

const NO_SKIP: ArrivalSkip = { templates: [], tags: [] };

/** A tag as compared: trimmed, without a leading #, in lower case. */
const tagKey = (t: string) => t.trim().replace(/^#/, '').toLowerCase();

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** `arrivalSkip` as stored in settings/assistant, whatever shape it has. */
export function arrivalSkipOf(v: unknown): ArrivalSkip {
  if (typeof v !== 'object' || v === null) return NO_SKIP;
  const o = v as Record<string, unknown>;
  return { templates: strings(o['templates']), tags: strings(o['tags']) };
}

/**
 * Whether Eric holds this note back from arrival (#229): the note's
 * own Leave this note alone, then a template, then a tag Settings
 * names, in that order.
 */
export function leftAlone(note: NoteFields, skip: ArrivalSkip = NO_SKIP): boolean {
  if (note.gardenHold === true) return true;
  if (typeof note.fromTemplate === 'string' && skip.templates.includes(note.fromTemplate)) {
    return true;
  }
  const skipped = new Set(skip.tags.map(tagKey).filter(Boolean));
  return strings(note.tags).some((t) => skipped.has(tagKey(t)));
}

const settled = (v: unknown) => v instanceof Timestamp;

/**
 * Whether this write is a note's arrival (#214): its first settle
 * (`settledAt` absent before, set now), on a plain text note of the
 * gardener's own with words in it, not sent or done already. A note
 * settling again, or taken back after it was sent, is not an arrival,
 * nor is one Eric holds back (#229), which is checked first.
 */
export function arrives(
  noteId: string,
  before: NoteFields | undefined,
  after: NoteFields | undefined,
  skip: ArrivalSkip = NO_SKIP,
): boolean {
  if (!after || noteId === 'context') return false;
  if (leftAlone(after, skip)) return false;
  if (settled(before?.settledAt) || !settled(after.settledAt)) return false;
  return (
    after.kind === 'text' &&
    after.archived !== true &&
    after.deletedAt === undefined &&
    after.updatedBy === 'user' &&
    typeof after.body === 'string' &&
    after.body.trim() !== '' &&
    after.sendState === undefined
  );
}

/**
 * Starts a run on a note, as `how` asks, and returns its id:
 * - `now`, Do it now: the note must be queued already; a run going is
 *   joined, one lost with its function replaced.
 * - `arrival`, Garden on arrival: the note must still arrive (unsent);
 *   it is queued here with no ask and marked `sentOnArrival`, under a
 *   run id of its own, and only while the day's runs are not spent.
 * Either way the run is written `requested`, for agentRun to claim.
 */
export async function requestRun(
  db: Firestore,
  uid: string,
  noteId: string,
  how: 'now' | 'arrival',
): Promise<string> {
  if ((await firestoreKeyStore(db).ciphertext(uid, 'anthropic')) === undefined) {
    throw new HttpsError(
      'failed-precondition',
      'Add an Anthropic key in Settings, AI assistants, to do it now.',
    );
  }
  const runId = how === 'arrival' ? arrivalRunId(noteId) : db.collection(paths.runs(uid)).doc().id;
  await db.runTransaction(async (tx) => {
    const noteRef = db.doc(paths.note(uid, noteId));
    const runRef = db.doc(paths.run(uid, runId));
    const usageRef = db.doc(paths.usage(uid, dayOf(Date.now())));
    const [noteDoc, had, usage] = await Promise.all([
      tx.get(noteRef),
      how === 'arrival' ? tx.get(runRef) : undefined,
      how === 'arrival' ? tx.get(usageRef) : undefined,
    ]);
    const note = noteDoc.data();
    if (!note || note['archived'] === true || note['deletedAt'] !== undefined)
      throw new HttpsError('not-found', 'No such note.');
    let sentAt = note['sentAt'];
    let queue: Record<string, unknown> = {};
    if (how === 'arrival') {
      if (had?.exists) throw new HttpsError('already-exists', 'Already sent on arrival.');
      if (note['sendState'] !== undefined) {
        throw new HttpsError('failed-precondition', 'Already sent.');
      }
      // Held back since the write that settled it (#229).
      if (note['gardenHold'] === true) throw new HttpsError('failed-precondition', 'Held back.');
      // A spent day leaves the note unsent: Eric did not send it, and
      // queued it would wait on a routine he may not run.
      if (Number(usage?.data()?.['runs'] ?? 0) >= DAILY_RUNS) {
        throw new HttpsError('resource-exhausted', `Today’s ${DAILY_RUNS} runs are used up.`);
      }
      sentAt = Timestamp.now();
      queue = {
        sendState: 'queued',
        sentAt,
        sentOnArrival: true,
        sendAsk: FieldValue.delete(),
        sendOutcome: FieldValue.delete(),
      };
    } else {
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
    }
    tx.set(runRef, {
      kind: 'queued-note',
      noteId,
      sentAt,
      status: 'requested',
      ...(how === 'arrival' ? { arrival: true } : {}),
      steps: [],
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(noteRef, { ...queue, sendRun: runId });
  });
  return runId;
}

/** What a note's write came to under Garden on arrival (#214). */
export type ArrivalOutcome =
  'sent' | 'not-arrival' | 'off' | 'skipped' | 'no-key' | 'capped' | 'already' | 'gone';

/**
 * Garden on arrival (#214, step 1 of #155): on a note's arrival, with
 * the gardener's switch on and an Anthropic key kept, queues it with no
 * ask and starts its run, as Send to an assistant and Do it now would
 * together. A note held back, or made from a template or carrying a
 * tag Settings skips (#229), is left as it is, as is everything else.
 */
export async function gardenOnArrival(
  db: Firestore,
  uid: string,
  noteId: string,
  before: NoteFields | undefined,
  after: NoteFields | undefined,
): Promise<ArrivalOutcome> {
  if (!arrives(noteId, before, after)) return 'not-arrival';
  const settings = await db.doc(paths.assistant(uid)).get();
  if (settings.get('gardenOnArrival') !== true) return 'off';
  if (!arrives(noteId, before, after, arrivalSkipOf(settings.get('arrivalSkip')))) {
    return 'skipped';
  }
  if ((await firestoreKeyStore(db).ciphertext(uid, 'anthropic')) === undefined) return 'no-key';
  try {
    await requestRun(db, uid, noteId, 'arrival');
    return 'sent';
  } catch (err) {
    if (!(err instanceof HttpsError)) throw err;
    if (err.code === 'resource-exhausted') return 'capped';
    if (err.code === 'not-found') return 'gone';
    // Sent meanwhile, or its arrival already started a run.
    return 'already';
  }
}
