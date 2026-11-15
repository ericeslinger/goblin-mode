// Seal everything now, for runs (note encryption, the migration, Eric,
// 2026-11-15; DESIGN.md, "Note encryption", The migration). A run's
// item text, item key and result are its note's words
// (SEALED_RECORD_FIELDS.runs), sealed under the run's own id
// (`recordAadFor`). An item run made while its note was plain is also
// named by a plain hash of its item (`item-{noteId}-{hex}`): a finished
// one moves to the id its note's keyed hash gives, created and the old
// one deleted in one transaction, so no guessable hash of the item is
// left and itemAssigned, which looks under the keyed id first, still
// never starts the item twice. A run still going is left for the next
// pass, so nothing here races agentRun.
import { SEALED_RECORD_FIELDS, type SealedRecordField, isSealed, paths } from '@mossgoblin/schema';
import type { Firestore } from 'firebase-admin/firestore';
import { type NoteCodec, SealedNoteError, SealedRecordError } from '../mcp/note-text';
import { itemRunId } from './items';

/** What one document came to in a pass (notes/seal-all.ts reads it). */
export interface SealedUnit {
  result: 'sealed' | 'already' | 'cannot-open' | 'busy' | 'not-verified';
  /** An item run moved to its keyed id. */
  moved?: true;
  /** An item run sealed, left under its plain id: a newer run holds the keyed one. */
  idKept?: true;
}

/** What was sealed did not open back to the same text: nothing is written. */
export class NotVerified extends Error {
  override readonly name = 'NotVerified';
}

type RunField = SealedRecordField<'runs'>;
const RUN_FIELDS: readonly RunField[] = SEALED_RECORD_FIELDS.runs;

/**
 * Seals run `runId`'s text and, for a finished item run under a plain
 * id, moves it to its keyed id. A transaction that reads the run as it
 * is, opens every sealed field, seals each plain one under the id it
 * will be stored under (every one again, when it moves), and checks
 * each opens back to the text it replaces before anything is written.
 * `dryRun` decides the same and writes nothing.
 */
export async function sealRun(
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  runId: string,
  dryRun: boolean,
): Promise<SealedUnit> {
  const ref = db.doc(paths.run(uid, runId));
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { result: 'already' };
      const run = snap.data()!;
      const text: Partial<Record<RunField, string>> = {};
      let plain = false;
      for (const f of RUN_FIELDS) {
        const v = run[f];
        if (typeof v !== 'string') continue;
        if (!isSealed(v)) plain = true;
        text[f] = await codec.openRecord('runs', runId, f, v);
      }
      // The id the run should have: a finished item run under the plain
      // hash of its key goes to the keyed one.
      let target = runId;
      let idKept = false;
      const noteId = typeof run['noteId'] === 'string' ? run['noteId'] : '';
      const key = text['itemKey'];
      if (run['kind'] === 'item' && noteId && key !== undefined) {
        const plainId = itemRunId(noteId, await codec.itemHash(noteId, key, 'plain'));
        if (plainId === runId) {
          const keyedId = itemRunId(noteId, await codec.itemHash(noteId, key, 'sealed'));
          if ((await tx.get(db.doc(paths.run(uid, keyedId)))).exists) idKept = true;
          else target = keyedId;
        }
      }
      if (!plain && target === runId)
        return idKept ? { result: 'already', idKept: true } : { result: 'already' };
      const live = run['status'] === 'requested' || run['status'] === 'working';
      if (live) return { result: 'busy' };
      const done: SealedUnit = {
        result: 'sealed',
        ...(target !== runId ? { moved: true as const } : {}),
        ...(idKept ? { idKept: true as const } : {}),
      };
      if (dryRun) return done;
      const moving = target !== runId;
      const sealed: Partial<Record<RunField, string>> = {};
      for (const f of RUN_FIELDS) {
        const t = text[f];
        if (t === undefined) continue;
        // In place, a field sealed already stays as it is.
        if (!moving && isSealed(run[f])) continue;
        const value = await codec.sealRecord('runs', target, f, t, 'sealed');
        if ((await codec.openRecord('runs', target, f, value)) !== t) throw new NotVerified();
        sealed[f] = value;
      }
      if (moving) {
        tx.set(db.doc(paths.run(uid, target)), { ...run, ...sealed });
        tx.delete(ref);
      } else tx.update(ref, sealed);
      return done;
    });
  } catch (err) {
    if (err instanceof SealedRecordError || err instanceof SealedNoteError) {
      return { result: 'cannot-open' };
    }
    if (err instanceof NotVerified) return { result: 'not-verified' };
    throw err;
  }
}
