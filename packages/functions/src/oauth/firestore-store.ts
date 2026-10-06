import type { Firestore } from 'firebase-admin/firestore';
import type { Client, CodeGrant, OAuthStore, TokenGrant } from './core';

/**
 * OAuth state under the top-level `oauth` collection, which the rules
 * deny to every client: oauth/clients/items/{clientId},
 * oauth/codes/items/{sha256(code)}, oauth/tokens/items/{sha256(token)}.
 */
export function firestoreOAuthStore(db: Firestore): OAuthStore {
  const clients = db.collection('oauth/clients/items');
  const codes = db.collection('oauth/codes/items');
  const tokens = db.collection('oauth/tokens/items');

  const take = <T>(ref: FirebaseFirestore.DocumentReference) =>
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return undefined;
      tx.delete(ref);
      return snap.data() as T;
    });

  return {
    async saveClient(client) {
      await clients.doc(client.clientId).set(client);
    },
    async client(clientId) {
      const snap = await clients.doc(clientId).get();
      return snap.exists ? (snap.data() as Client) : undefined;
    },
    async saveCode(h, grant) {
      await codes.doc(h).set(grant);
    },
    takeCode: (h) => take<CodeGrant>(codes.doc(h)),
    async saveToken(h, grant) {
      await tokens.doc(h).set(grant);
    },
    async token(h) {
      const snap = await tokens.doc(h).get();
      return snap.exists ? (snap.data() as TokenGrant) : undefined;
    },
    takeToken: (h) => take<TokenGrant>(tokens.doc(h)),
    async revokeAll(uid) {
      const snap = await tokens.where('uid', '==', uid).get();
      const batch = db.batch();
      for (const doc of snap.docs) batch.delete(doc.ref);
      await batch.commit();
      return snap.size;
    },
  };
}
