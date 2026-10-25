import { FieldValue, type Firestore, Timestamp } from 'firebase-admin/firestore';
import { paths } from '@mossgoblin/schema';
import type { RunStore } from './core';

const iso = (v: unknown) => (v instanceof Timestamp ? v.toDate().toISOString() : undefined);

/** Runs under `users/{uid}/runs`, counted in the day's `usage` doc like transcriptions. */
export function firestoreRunStore(db: Firestore): RunStore {
  return {
    claim: (uid, runId, day, cap) =>
      db.runTransaction(async (tx) => {
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
      }),
    update: async (uid, runId, fields) => {
      const done = fields['status'] === 'done' || fields['status'] === 'failed';
      await db
        .doc(paths.run(uid, runId))
        .set(
          { ...fields, ...(done ? { finishedAt: FieldValue.serverTimestamp() } : {}) },
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
      if (!doc.exists) return undefined;
      const d = doc.data()!;
      return {
        title: String(d['title'] ?? ''),
        sendState: typeof d['sendState'] === 'string' ? d['sendState'] : undefined,
        sentAt: iso(d['sentAt']),
        sendAsk: typeof d['sendAsk'] === 'string' && d['sendAsk'] ? d['sendAsk'] : undefined,
      };
    },
  };
}
