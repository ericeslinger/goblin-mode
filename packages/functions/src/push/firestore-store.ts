import { paths } from '@mossgoblin/schema';
import { FieldValue, type Firestore, Timestamp } from 'firebase-admin/firestore';
import type { Device, DueReminder, PushStore } from './send-due';

function millis(v: unknown): number | undefined {
  return v instanceof Timestamp ? v.toMillis() : undefined;
}

/** The PushStore over Firestore, as the admin SDK (rules do not apply). */
export function firestoreStore(db: Firestore): PushStore {
  return {
    async due(now, limit) {
      // A collection-group query; firestore.indexes.json enables its index.
      const snap = await db
        .collectionGroup('reminders')
        .where('nextFireAt', '<=', Timestamp.fromMillis(now))
        .orderBy('nextFireAt')
        .limit(limit)
        .get();
      return snap.docs.flatMap((d): DueReminder[] => {
        const owner = d.ref.parent.parent;
        if (!owner || owner.parent.id !== 'users') return [];
        const data = d.data();
        const nextFireAt = millis(data['nextFireAt']);
        if (nextFireAt === undefined) return [];
        return [
          {
            uid: owner.id,
            id: d.id,
            text: String(data['text'] ?? ''),
            status: data['status'],
            dueAt: millis(data['dueAt']),
            snoozedUntil: millis(data['snoozedUntil']),
            nextFireAt,
            recurrence: data['recurrence'],
            noteId: typeof data['noteId'] === 'string' ? data['noteId'] : undefined,
          },
        ];
      });
    },

    claim(r, expected, next) {
      const ref = db.doc(`${paths.reminders(r.uid)}/${r.id}`);
      return db.runTransaction(async (tx) => {
        const current = await tx.get(ref);
        if (millis(current.get('nextFireAt')) !== expected) return false;
        tx.update(ref, {
          nextFireAt: next === undefined ? FieldValue.delete() : Timestamp.fromMillis(next),
        });
        return true;
      });
    },

    async devices(uid) {
      const snap = await db.collection(paths.devices(uid)).get();
      return snap.docs.flatMap((d): Device[] => {
        const token = d.get('token');
        return typeof token === 'string' && token ? [{ id: d.id, token }] : [];
      });
    },

    async removeDevice(uid, deviceId) {
      await db.doc(`${paths.devices(uid)}/${deviceId}`).delete();
    },
  };
}
