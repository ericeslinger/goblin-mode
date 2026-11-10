import { paths } from '@mossgoblin/schema';
import { type Firestore, Timestamp } from 'firebase-admin/firestore';
import type { DigestStore, DigestSubscriber } from './digest';
import { firestoreStore } from './firestore-store';

/** The most records one digest reads; a busier day is counted to here. */
export const DIGEST_RECORDS = 500;

/** Where the last digest sent is kept: server only, like the day's usage. */
export const digestStatePath = (uid: string) => paths.usage(uid, 'digest');

const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined);

/** The DigestStore over Firestore, as the admin SDK (rules do not apply). */
export function firestoreDigestStore(db: Firestore): DigestStore {
  const push = firestoreStore(db);
  return {
    devices: push.devices,
    removeDevice: push.removeDevice,

    async subscribers() {
      // A collection-group query; firestore.indexes.json enables its index.
      const snap = await db.collectionGroup('settings').where('digest.push', '==', true).get();
      return snap.docs.flatMap((d): DigestSubscriber[] => {
        const owner = d.ref.parent.parent;
        if (d.id !== 'assistant' || !owner || owner.parent.id !== 'users') return [];
        const digest = d.get('digest') as Record<string, unknown> | undefined;
        const hour = digest?.['hour'];
        if (typeof hour !== 'number' || !Number.isInteger(hour)) return [];
        const timeZone = digest?.['timeZone'];
        return [
          {
            uid: owner.id,
            hour,
            ...(typeof timeZone === 'string' && timeZone ? { timeZone } : {}),
          },
        ];
      });
    },

    async records(uid, from, to) {
      const snap = await db
        .collection(paths.activity(uid))
        .where('at', '>=', Timestamp.fromMillis(from))
        .where('at', '<', Timestamp.fromMillis(to))
        .orderBy('at')
        .limit(DIGEST_RECORDS)
        .get();
      return snap.docs.map((d) => {
        const data = d.data();
        const notes = Array.isArray(data['notes']) ? data['notes'] : [];
        return {
          at: millis(data['at']),
          tool: String(data['tool'] ?? ''),
          summary: String(data['summary'] ?? ''),
          notes: notes.map((n: Record<string, unknown>) => ({
            id: String(n['id'] ?? ''),
            title: String(n['title'] ?? ''),
            ...(n['made'] === true ? { made: true } : {}),
            ...(n['before'] && typeof n['before'] === 'object' ? { before: n['before'] } : {}),
          })),
        };
      });
    },

    async projects(uid, ids) {
      const refs = ids.map((id) => db.doc(paths.note(uid, id)));
      const docs = refs.length ? await db.getAll(...refs) : [];
      return new Set(docs.filter((d) => d.get('conceptType') === 'project').map((d) => d.id));
    },

    claim(uid, day) {
      const ref = db.doc(digestStatePath(uid));
      return db.runTransaction(async (tx) => {
        const current = await tx.get(ref);
        if (current.get('sentFor') === day) return false;
        tx.set(ref, { sentFor: day, sentAt: Timestamp.now() }, { merge: true });
        return true;
      });
    },
  };
}
