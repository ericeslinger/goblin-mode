import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { type Provider, paths } from '@mossgoblin/schema';
import { type KeyStore } from './core';
import { type KeyMarks } from './use';

/**
 * Where keys live (#144): the ciphertext under `secrets/{uid}`, which no
 * rule lets a client read, and the masked record under the gardener's
 * `settings/keys`, which the app reads and the functions alone write.
 * Both change in one batch, so the app never shows a key that is gone.
 */
export function firestoreKeyStore(db: Firestore): KeyStore & KeyMarks {
  return {
    async put(uid, provider, ciphertext, masked) {
      const now = FieldValue.serverTimestamp();
      const batch = db.batch();
      batch.set(
        db.doc(paths.secrets(uid)),
        { [provider]: { ciphertext, updatedAt: now } },
        { merge: true },
      );
      batch.set(
        db.doc(paths.keys(uid)),
        // A new key is not the broken one.
        { [provider]: { masked, updatedAt: now, broken: FieldValue.delete() }, updatedAt: now },
        { merge: true },
      );
      await batch.commit();
    },
    async drop(uid, provider) {
      const gone = FieldValue.delete();
      const batch = db.batch();
      batch.set(db.doc(paths.secrets(uid)), { [provider]: gone }, { merge: true });
      batch.set(
        db.doc(paths.keys(uid)),
        { [provider]: gone, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      await batch.commit();
    },
    async ciphertext(uid, provider) {
      const doc = await db.doc(paths.secrets(uid)).get();
      const field = doc.get(provider) as { ciphertext?: unknown } | undefined;
      return typeof field?.ciphertext === 'string' ? field.ciphertext : undefined;
    },
    async markUsed(uid, provider) {
      const now = FieldValue.serverTimestamp();
      await db
        .doc(paths.keys(uid))
        .set({ [provider]: { lastUsedAt: now }, updatedAt: now }, { merge: true });
    },
    async markBroken(uid, provider) {
      await db
        .doc(paths.keys(uid))
        .set(
          { [provider]: { broken: true }, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
    },
  };
}
