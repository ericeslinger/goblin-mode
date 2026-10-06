// An in-memory OAuthStore for specs; never imported from production code.
import type { Client, CodeGrant, OAuthStore, Spent, TokenGrant } from './core';

export function memoryOAuthStore(): OAuthStore & {
  clients: Map<string, Client>;
  codes: Map<string, CodeGrant>;
  tokens: Map<string, TokenGrant>;
} {
  const clients = new Map<string, Client>();
  const codes = new Map<string, CodeGrant>();
  const tokens = new Map<string, TokenGrant>();
  function spend<T extends { spent?: boolean; expiresAt: number }>(
    m: Map<string, T>,
    k: string,
    keepUntil: number,
  ): Spent<T> {
    const grant = m.get(k);
    if (!grant) return undefined;
    if (grant.spent) return { grant, reused: true };
    m.set(k, { ...grant, spent: true, expiresAt: keepUntil });
    return { grant, reused: false };
  }
  const deleteWhere = <T>(m: Map<string, T>, test: (v: T) => boolean) => {
    let n = 0;
    for (const [k, v] of m) if (test(v) && m.delete(k)) n++;
    return n;
  };
  return {
    clients,
    codes,
    tokens,
    saveClient: async (c) => void clients.set(c.clientId, c),
    client: async (id) => clients.get(id),
    saveCode: async (h, g) => void codes.set(h, g),
    spendCode: async (h, keep) => spend(codes, h, keep),
    saveToken: async (h, g) => void tokens.set(h, g),
    token: async (h) => tokens.get(h),
    spendRefresh: async (h, keep) =>
      tokens.get(h)?.kind === 'refresh' ? spend(tokens, h, keep) : undefined,
    deleteFamily: async (family, kind) =>
      deleteWhere(tokens, (g) => g.family === family && (!kind || g.kind === kind)),
    revokeAll: async (uid) =>
      deleteWhere(tokens, (g) => g.uid === uid) + deleteWhere(codes, (g) => g.uid === uid),
    sweep: async (uid, now) => {
      deleteWhere(tokens, (g) => g.uid === uid && g.expiresAt <= now);
      deleteWhere(codes, (g) => g.uid === uid && g.expiresAt <= now);
    },
  };
}
