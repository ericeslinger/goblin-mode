import {
  Habit,
  habitEntries,
  habitLogId,
  habitMonth,
  habitsConfig,
  moduleOn,
  paths,
} from '@mossgoblin/schema';
import { type Firestore, Timestamp } from 'firebase-admin/firestore';
import { readHabitDays } from '../mcp/habits';
import { firestoreStore } from './firestore-store';
import type { NudgeStore, NudgingHabit } from './habit-nudges';

/**
 * Where the nudges sent are marked: server only, like the digest's
 * (`usage/digest`); the rules allow no client anything under `usage`.
 * One document per gardener, `sent.<habitId>` the last day (YYYY-MM-DD
 * in the zone the nudge was read in, `habitZone`) a nudge was sent for
 * that habit: a weekly or monthly habit's is the last day of its period,
 * and a mark anywhere in a period stops a second nudge in it. A weekly
 * habit of `times` (2026-11-23) can be nudged on several days of a week,
 * so its mark stops one for that day or an earlier one only: the same
 * one field, the day it was last sent, no shape changed.
 */
export const nudgeStatePath = (uid: string) => paths.usage(uid, 'habitNudges');

const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined);

function sentMarks(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
}

/** The NudgeStore over Firestore, as the admin SDK (rules do not apply). */
export function firestoreNudgeStore(db: Firestore): NudgeStore {
  const push = firestoreStore(db);
  return {
    devices: push.devices,
    removeDevice: push.removeDevice,

    async nudging() {
      // A collection-group query; firestore.indexes.json enables its index.
      const snap = await db.collectionGroup('habits').where('nudge', '==', true).get();
      return snap.docs.flatMap((d): NudgingHabit[] => {
        const owner = d.ref.parent.parent;
        if (!owner || owner.parent.id !== 'users') return [];
        // A habit that does not parse is passed over, as everywhere.
        const parsed = Habit.safeParse(d.data());
        if (!parsed.success) return [];
        const changedAt = millis(d.get('updatedAt'));
        return [
          {
            uid: owner.id,
            id: d.id,
            habit: parsed.data,
            ...(changedAt !== undefined ? { changedAt } : {}),
          },
        ];
      });
    },

    async module(uid) {
      const data = (await db.doc(paths.modules(uid)).get()).data();
      return {
        on: moduleOn(data, 'habits'),
        config: habitsConfig((data?.['habits'] as { config?: unknown } | undefined)?.config),
      };
    },

    async sent(uid) {
      return sentMarks((await db.doc(nudgeStatePath(uid)).get()).get('sent'));
    },

    claim(uid, id, day, period, stillDue) {
      const habitRef = db.doc(paths.habit(uid, id));
      // The period's months: one, or two for a week across a month's start.
      const months = [...new Set([habitMonth(period.start), habitMonth(period.end)])];
      const logRefs = months.map((m) => db.doc(paths.habitLog(uid, habitLogId(id, m))));
      const stateRef = db.doc(nudgeStatePath(uid));
      return db.runTransaction(async (tx) => {
        const [habitSnap, stateSnap, ...logSnaps] = await tx.getAll(habitRef, stateRef, ...logRefs);
        const parsed = Habit.safeParse(habitSnap.data());
        const entries = habitEntries(
          logSnaps.map((snap, i) => ({
            month: months[i],
            days: readHabitDays(snap.data(), months[i]),
          })),
        );
        const sentFor = sentMarks(stateSnap.get('sent'))[id];
        const changedAt = millis(habitSnap.get('updatedAt'));
        const due = stillDue({
          ...(parsed.success ? { habit: parsed.data } : {}),
          ...(changedAt !== undefined ? { changedAt } : {}),
          entries,
          ...(sentFor !== undefined ? { sentFor } : {}),
        });
        if (!due) return false;
        tx.set(stateRef, { sent: { [id]: day }, updatedAt: Timestamp.now() }, { merge: true });
        return true;
      });
    },
  };
}
