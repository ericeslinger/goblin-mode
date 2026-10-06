import { InjectionToken } from '@angular/core';

/** What the consent page shows: who is asking, and where it goes back to. */
export interface Consent {
  clientName: string;
  redirectOrigin: string;
}

/**
 * The calls to the oauth function (on this origin, through the Worker),
 * and leaving the page, as a seam for unit specs.
 */
export interface ClaudeAccessApi {
  consent(query: string): Promise<Consent>;
  approve(params: Record<string, string>, idToken: string): Promise<string>;
  revoke(idToken: string): Promise<number>;
  go(url: string): void;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(body['error_description'] ?? body['error'] ?? `HTTP ${res.status}`));
  }
  return body as T;
}

export const CLAUDE_ACCESS_API = new InjectionToken<ClaudeAccessApi>('claude-access-api', {
  providedIn: 'root',
  factory: () => ({
    consent: async (query) => {
      const body = await call<{ client_name: string; redirect_origin: string }>(
        `/oauth/approve?${query}`,
      );
      return { clientName: body.client_name, redirectOrigin: body.redirect_origin };
    },
    approve: async (params, idToken) =>
      (
        await call<{ redirect: string }>('/oauth/approve', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
          body: JSON.stringify(params),
        })
      ).redirect,
    revoke: async (idToken) =>
      (
        await call<{ revoked: number }>('/oauth/revoke', {
          method: 'POST',
          headers: { authorization: `Bearer ${idToken}` },
        })
      ).revoked,
    go: (url) => location.assign(url),
  }),
});
