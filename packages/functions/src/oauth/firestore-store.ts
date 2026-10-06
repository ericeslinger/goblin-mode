import type { DocumentReference, Firestore, Query } from 'firebase-admin/firestore';
import type { Client, CodeGrant, OAuthStore, Spent, TokenGrant } from './core';

/** Well under Firestore's 500 writes per batch. */
const CHUNK = 400;

/**
 * OAuth state under the top-level `oauth` collection, which the rules
 * deny to every client: oauth/clients/items/{clientId},
 * oauth/codes/items/{sha256(code)}, oauth/tokens/items/{sha256(token)}.
 */
export function firestoreOAuthStore(db: Firestore): OAuthStore {
  const clients = db.collection('oauth/clients/items');
  const codes = db.collection('oauth/codes/items');
  const tokens = db.collection('oauth/tokens/items');

  /** Marks a one-time secret spent in one step; see OAuthStore.spendCode. */
  const spend = <T extends { expiresAt: number; spent?: boolean }>(
    ref: DocumentReference,
    keepUntil: number,
    accept: (grant: T) => boolean = () => true,
  ) =>
    db.runTransaction(async (tx): Promise<Spent<T>> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return undefined;
      const grant = snap.data() as T;
      if (!accept(grant)) return undefined;
      if (grant.spent) return { grant, reused: true };
      tx.update(ref, { spent: true, expiresAt: keepUntil });
      return { grant, reused: false };
    });

  /** Deletes refs in chunks, so no batch passes the write limit. */
  async function deleteRefs(refs: DocumentReference[]): Promise<number> {
    for (let i = 0; i < refs.length; i += CHUNK) {
      const batch = db.batch();
      for (const ref of refs.slice(i, i + CHUNK)) batch.delete(ref);
      await batch.commit();
    }
    return refs.length;
  }

  const refsOf = async (q: Query) => (await q.select().get()).docs.map((d) => d.ref);

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
    spendCode: (h, keepUntil) => spend<CodeGrant>(codes.doc(h), keepUntil),
    async saveToken(h, grant) {
      await tokens.doc(h).set(grant);
    },
    async token(h) {
      const snap = await tokens.doc(h).get();
      return snap.exists ? (snap.data() as TokenGrant) : undefined;
    },
    spendRefresh: (h, keepUntil) =>
      spend<TokenGrant>(tokens.doc(h), keepUntil, (g) => g.kind === 'refresh'),
    async deleteFamily(family, kind) {
      // Equality filters only: served by single-field indexes.
      let q: Query = tokens.where('family', '==', family);
      if (kind) q = q.where('kind', '==', kind);
      return deleteRefs(await refsOf(q));
    },
    async revokeAll(uid) {
      const t = await refsOf(tokens.where('uid', '==', uid));
      const c = await refsOf(codes.where('uid', '==', uid));
      return deleteRefs([...t, ...c]);
    },
    async sweep(uid, now) {
      // One owner holds few tokens once they are swept, so filter here
      // rather than need a composite index on uid and expiresAt.
      const expired = async (q: Query) =>
        (await q.get()).docs.filter((d) => d.get('expiresAt') <= now).map((d) => d.ref);
      await deleteRefs([
        ...(await expired(tokens.where('uid', '==', uid))),
        ...(await expired(codes.where('uid', '==', uid))),
      ]);
    },
  };
}
