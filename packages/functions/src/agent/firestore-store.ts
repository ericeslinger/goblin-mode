import { FieldValue, type Firestore, Timestamp } from 'firebase-admin/firestore';
import { type NoteForm, formsFound, isSealed, paths, recordForm } from '@mossgoblin/schema';
import {
  type KeyFor,
  NoteCodec,
  SealedRecordError,
  formsOf,
  shownTitle,
  storedText,
} from '../mcp/note-text';
import { dataKeyFor } from '../note-keys/client';
import type { RunStore } from './core';

const iso = (v: unknown) => (v instanceof Timestamp ? v.toDate().toISOString() : undefined);

/**
 * Runs under `users/{uid}/runs`, counted in the day's `usage` doc like
 * transcriptions. One codec a gardener, for the run's note state and
 * the run's own text (step 3e, 2026-11-13): a claimed item run comes
 * back with its key and text opened, and an outcome is stored sealed
 * when its item was, or its note is (`recordForm`).
 */
export function firestoreRunStore(db: Firestore, keyFor: KeyFor = dataKeyFor): RunStore {
  const codecs = new Map<string, NoteCodec>();
  const codecFor = (uid: string) => {
    let codec = codecs.get(uid);
    if (!codec) codecs.set(uid, (codec = new NoteCodec(uid, keyFor)));
    return codec;
  };
  /** The form a run's outcome is stored in: its item's, else its note's now. */
  const outcomeForm = async (uid: string, runId: string): Promise<NoteForm> => {
    const run = (await db.doc(paths.run(uid, runId)).get()).data();
    if (isSealed(run?.['itemKey']) || isSealed(run?.['itemText'])) return 'sealed';
    const noteId = run?.['noteId'];
    if (typeof noteId !== 'string' || !noteId) return 'plain';
    return recordForm(formsFound((await db.doc(paths.note(uid, noteId)).get()).data()));
  };
  /** A claimed run with its item's text opened; one that did not open says why. */
  const opened = async (uid: string, runId: string, run: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...run };
    try {
      for (const field of ['itemKey', 'itemText'] as const) {
        const v = run[field];
        if (typeof v === 'string')
          out[field] = await codecFor(uid).openRecord('runs', runId, field, v);
      }
    } catch (err) {
      if (!(err instanceof SealedRecordError)) throw err;
      delete out['itemKey'];
      delete out['itemText'];
      out['unopened'] = err.reason;
    }
    return out;
  };
  return {
    claim: async (uid, runId, day, cap) => {
      const claim = await db.runTransaction(async (tx) => {
        const ref = db.doc(paths.run(uid, runId));
        const usageRef = db.doc(paths.usage(uid, day));
        const [doc, usage] = await Promise.all([tx.get(ref), tx.get(usageRef)]);
        const data = doc.data();
        if (!data || data['status'] !== 'requested') return { status: 'skip' as const };
        const used = Number(usage.data()?.['runs'] ?? 0);
        if (used >= cap) return { status: 'capped' as const };
        tx.set(usageRef, { runs: used + 1 }, { merge: true });
        tx.set(
          ref,
          { status: 'working', startedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        return {
          status: 'claimed' as const,
          run: { ...data, sentAt: iso(data['sentAt']) },
        };
      });
      return claim.status === 'claimed'
        ? { status: 'claimed' as const, run: await opened(uid, runId, claim.run) }
        : claim;
    },
    update: async (uid, runId, fields) => {
      const done = fields['status'] === 'done' || fields['status'] === 'failed';
      const outcome = fields['outcome'];
      const sealed =
        typeof outcome === 'string'
          ? {
              outcome: await codecFor(uid).sealRecord(
                'runs',
                runId,
                'outcome',
                outcome,
                await outcomeForm(uid, runId),
              ),
            }
          : {};
      await db
        .doc(paths.run(uid, runId))
        .set(
          { ...fields, ...sealed, ...(done ? { finishedAt: FieldValue.serverTimestamp() } : {}) },
          { merge: true },
        );
    },
    step: async (uid, runId, step) => {
      await db.doc(paths.run(uid, runId)).update({
        steps: FieldValue.arrayUnion({ ...step, at: Timestamp.now() }),
      });
    },
    noteState: async (uid, noteId) => {
      const doc = await db.doc(paths.note(uid, noteId)).get();
      // A note in Trash (#217) is gone to a run, as one not there.
      if (!doc.exists || doc.get('deletedAt') !== undefined) return undefined;
      const d = doc.data()!;
      // The ask goes into the run's brief, so a sealed one is opened
      // (2026-11-13); one that cannot be opened here throws
      // SealedNoteError, and the run fails saying the note is sealed,
      // rather than doing it without the ask.
      const ask = await codecFor(uid).open(noteId, 'sendAsk', storedText(d, 'sendAsk'));
      return {
        // Not opened: nothing here reads it, and a sealed one is never
        // carried in the clear (2026-11-13).
        title: shownTitle(storedText(d, 'title'), recordForm(formsOf(d))),
        sendState: typeof d['sendState'] === 'string' ? d['sendState'] : undefined,
        sentAt: iso(d['sentAt']),
        sendAsk: ask || undefined,
        ...(d['gardenHold'] === true ? { gardenHold: true } : {}),
      };
    },
  };
}
