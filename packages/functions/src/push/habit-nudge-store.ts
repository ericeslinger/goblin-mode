import {
  Habit,
  habitDayKey,
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
 * in the habit's zone) a nudge was sent for that habit.
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

    claim(uid, id, day, stillDue) {
      const habitRef = db.doc(paths.habit(uid, id));
      const month = habitMonth(day);
      const logRef = db.doc(paths.habitLog(uid, habitLogId(id, month)));
      const stateRef = db.doc(nudgeStatePath(uid));
      return db.runTransaction(async (tx) => {
        const [habitSnap, logSnap, stateSnap] = await tx.getAll(habitRef, logRef, stateRef);
        const parsed = Habit.safeParse(habitSnap.data());
        const logged = readHabitDays(logSnap.data(), month)[habitDayKey(day)];
        const sentFor = sentMarks(stateSnap.get('sent'))[id];
        const changedAt = millis(habitSnap.get('updatedAt'));
        const due = stillDue({
          ...(parsed.success ? { habit: parsed.data } : {}),
          ...(changedAt !== undefined ? { changedAt } : {}),
          ...(logged ? { logged } : {}),
          ...(sentFor !== undefined ? { sentFor } : {}),
        });
        if (!due) return false;
        tx.set(stateRef, { sent: { [id]: day }, updatedAt: Timestamp.now() }, { merge: true });
        return true;
      });
    },
  };
}
