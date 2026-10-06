// An in-memory OAuthStore for specs; never imported from production code.
import type { Client, CodeGrant, OAuthStore, TokenGrant } from './core';

export function memoryOAuthStore(): OAuthStore & {
  clients: Map<string, Client>;
  tokens: Map<string, TokenGrant>;
} {
  const clients = new Map<string, Client>();
  const codes = new Map<string, CodeGrant>();
  const tokens = new Map<string, TokenGrant>();
  const take = <T>(m: Map<string, T>, k: string) => {
    const v = m.get(k);
    m.delete(k);
    return v;
  };
  return {
    clients,
    tokens,
    saveClient: async (c) => void clients.set(c.clientId, c),
    client: async (id) => clients.get(id),
    saveCode: async (h, g) => void codes.set(h, g),
    takeCode: async (h) => take(codes, h),
    saveToken: async (h, g) => void tokens.set(h, g),
    token: async (h) => tokens.get(h),
    takeToken: async (h) => take(tokens, h),
    revokeAll: async (uid) => {
      let n = 0;
      for (const [k, g] of tokens) if (g.uid === uid && tokens.delete(k)) n++;
      return n;
    },
  };
}
