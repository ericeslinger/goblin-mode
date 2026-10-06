import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  OAuthError,
  approve,
  authServerMetadata,
  authenticate,
  checkAuthorize,
  register,
  token,
} from './core';
import { memoryOAuthStore } from './memory-store';

const T = 1_800_000_000_000;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function registered() {
  const store = memoryOAuthStore();
  const client = await register(store, { redirect_uris: [CALLBACK], client_name: 'Claude' }, T);
  const req = {
    clientId: client.clientId,
    redirectUri: CALLBACK,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    state: 'xyz',
  };
  return { store, client, req };
}

async function codeFrom(redirect: string) {
  const url = new URL(redirect);
  expect(url.origin + url.pathname).toBe(CALLBACK);
  expect(url.searchParams.get('state')).toBe('xyz');
  return url.searchParams.get('code')!;
}

const rejects = async (p: Promise<unknown>, error: string) => {
  await expect(p).rejects.toBeInstanceOf(OAuthError);
  await expect(p).rejects.toMatchObject({ error });
};

describe('OAuth', () => {
  it('describes itself on the public origin', () => {
    expect(authServerMetadata('https://notes.example.com')).toMatchObject({
      issuer: 'https://notes.example.com',
      authorization_endpoint: 'https://notes.example.com/oauth/authorize',
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('registers clients only for claude.ai and claude.com callbacks', async () => {
    const store = memoryOAuthStore();
    await rejects(
      register(store, { redirect_uris: ['https://evil.example/cb'] }, T),
      'invalid_redirect_uri',
    );
    await rejects(register(store, { redirect_uris: [] }, T), 'invalid_redirect_uri');
    const c = await register(
      store,
      { redirect_uris: ['https://claude.com/api/mcp/auth_callback'] },
      T,
    );
    expect(c.clientName).toBe('Claude');
  });

  it('checks the authorize request: client, redirect and S256', async () => {
    const { store, req } = await registered();
    await rejects(checkAuthorize(store, { ...req, clientId: 'nope' }), 'invalid_client');
    await rejects(
      checkAuthorize(store, { ...req, redirectUri: 'https://claude.ai/other' }),
      'invalid_request',
    );
    await rejects(
      checkAuthorize(store, { ...req, codeChallengeMethod: 'plain' }),
      'invalid_request',
    );
  });

  it('lets only the owner approve, then trades the code once, with PKCE', async () => {
    const { store, client, req } = await registered();
    await rejects(approve(store, req, 'stranger', 'owner', T), 'access_denied');
    await rejects(approve(store, req, 'owner', undefined, T), 'access_denied');
    const code = await codeFrom(await approve(store, req, 'owner', 'owner', T));

    const form = {
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: CALLBACK,
      code_verifier: 'wrong'.repeat(10),
    };
    await rejects(token(store, form, T), 'invalid_grant');
    // A failed attempt spends the code: it works once.
    const code2 = await codeFrom(await approve(store, req, 'owner', 'owner', T));
    const tokens = await token(store, { ...form, code: code2, code_verifier: verifier }, T);
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000 });
    await rejects(
      token(store, { ...form, code: code2, code_verifier: verifier }, T),
      'invalid_grant',
    );

    expect(await authenticate(store, `Bearer ${tokens.access_token}`, T)).toBe('owner');
    expect(await authenticate(store, `Bearer ${tokens.refresh_token}`, T)).toBeUndefined();
    expect(
      await authenticate(store, `Bearer ${tokens.access_token}`, T + ACCESS_TTL_MS),
    ).toBeUndefined();
    expect(await authenticate(store, undefined, T)).toBeUndefined();
  });

  it('refuses an expired code', async () => {
    const { store, client, req } = await registered();
    const code = await codeFrom(await approve(store, req, 'owner', 'owner', T));
    await rejects(
      token(
        store,
        {
          grant_type: 'authorization_code',
          client_id: client.clientId,
          code,
          redirect_uri: CALLBACK,
          code_verifier: verifier,
        },
        T + CODE_TTL_MS,
      ),
      'invalid_grant',
    );
  });

  it('rotates refresh tokens, and Disconnect drops them all', async () => {
    const { store, client, req } = await registered();
    const code = await codeFrom(await approve(store, req, 'owner', 'owner', T));
    const first = await token(
      store,
      {
        grant_type: 'authorization_code',
        client_id: client.clientId,
        code,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
      },
      T,
    );
    const refresh = {
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: first.refresh_token,
    };
    const second = await token(store, refresh, T + 1);
    expect(second.access_token).not.toBe(first.access_token);
    await rejects(token(store, refresh, T + 2), 'invalid_grant');
    await rejects(
      token(store, { ...refresh, refresh_token: first.access_token }, T),
      'invalid_grant',
    );

    expect(await store.revokeAll('owner')).toBe(3);
    expect(await authenticate(store, `Bearer ${second.access_token}`, T + 2)).toBeUndefined();
  });

  it('rejects unknown clients and grant types at the token endpoint', async () => {
    const { store, client } = await registered();
    await rejects(
      token(store, { grant_type: 'authorization_code', client_id: 'nope' }, T),
      'invalid_client',
    );
    await rejects(
      token(store, { grant_type: 'password', client_id: client.clientId }, T),
      'unsupported_grant_type',
    );
  });
});
