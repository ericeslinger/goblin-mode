import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  OAuthError,
  REFRESH_TTL_MS,
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
const RESOURCE = 'https://notes.example.com/mcp';
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
  const codeForm = (code: string) => ({
    grant_type: 'authorization_code',
    client_id: client.clientId,
    code,
    redirect_uri: CALLBACK,
    code_verifier: verifier,
  });
  const refreshForm = (refresh_token: string) => ({
    grant_type: 'refresh_token',
    client_id: client.clientId,
    refresh_token,
  });
  const newCode = async (at = T) =>
    new URL(await approve(store, req, RESOURCE, 'owner', 'owner', at)).searchParams.get('code')!;
  return { store, client, req, codeForm, refreshForm, newCode };
}

const rejects = async (p: Promise<unknown>, error: string) => {
  await expect(p).rejects.toBeInstanceOf(OAuthError);
  await expect(p).rejects.toMatchObject({ error });
};
const owner = (store: Parameters<typeof authenticate>[0], t: string, at = T) =>
  authenticate(store, `Bearer ${t}`, at);

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

  it('checks the authorize request: client, redirect, S256 and resource', async () => {
    const { store, req } = await registered();
    await rejects(checkAuthorize(store, { ...req, clientId: 'nope' }, RESOURCE), 'invalid_client');
    await rejects(
      checkAuthorize(store, { ...req, redirectUri: 'https://claude.ai/other' }, RESOURCE),
      'invalid_request',
    );
    await rejects(
      checkAuthorize(store, { ...req, codeChallengeMethod: 'plain' }, RESOURCE),
      'invalid_request',
    );
    await rejects(
      checkAuthorize(store, { ...req, resource: 'https://elsewhere.example/mcp' }, RESOURCE),
      'invalid_target',
    );
    await expect(
      checkAuthorize(store, { ...req, resource: `${RESOURCE}/` }, RESOURCE),
    ).resolves.toBeTruthy();
  });

  it('lets only the owner approve, then trades the code for tokens with PKCE', async () => {
    const { store, req, codeForm, newCode } = await registered();
    await rejects(approve(store, req, RESOURCE, 'stranger', 'owner', T), 'access_denied');
    await rejects(approve(store, req, RESOURCE, 'owner', undefined, T), 'access_denied');

    await rejects(
      token(store, { ...codeForm(await newCode()), code_verifier: 'w'.repeat(50) }, T),
      'invalid_grant',
    );
    const tokens = await token(store, codeForm(await newCode()), T);
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000 });
    expect(await owner(store, tokens.access_token)).toBe('owner');
    expect(await owner(store, tokens.refresh_token)).toBeUndefined();
    expect(await owner(store, tokens.access_token, T + ACCESS_TTL_MS)).toBeUndefined();
    expect(await authenticate(store, undefined, T)).toBeUndefined();
  });

  it('revokes everything a code gave when the code is replayed', async () => {
    const { store, codeForm, newCode } = await registered();
    const code = await newCode();
    const tokens = await token(store, codeForm(code), T);
    await rejects(token(store, codeForm(code), T + 1), 'invalid_grant');
    expect(await owner(store, tokens.access_token, T + 1)).toBeUndefined();
  });

  it('refuses an expired code', async () => {
    const { store, codeForm, newCode } = await registered();
    await rejects(token(store, codeForm(await newCode()), T + CODE_TTL_MS), 'invalid_grant');
  });

  it('rotates refresh tokens, dropping the old access token', async () => {
    const { store, codeForm, refreshForm, newCode } = await registered();
    const first = await token(store, codeForm(await newCode()), T);
    const second = await token(store, refreshForm(first.refresh_token), T + 1);
    expect(await owner(store, first.access_token, T + 1)).toBeUndefined();
    expect(await owner(store, second.access_token, T + 1)).toBe('owner');
    // An access token sent as a refresh token is refused, not spent.
    await rejects(token(store, refreshForm(second.access_token), T + 2), 'invalid_grant');
    expect(await owner(store, second.access_token, T + 2)).toBe('owner');
  });

  it('revokes the whole family when a rotated refresh token is replayed', async () => {
    const { store, codeForm, refreshForm, newCode } = await registered();
    const first = await token(store, codeForm(await newCode()), T);
    const second = await token(store, refreshForm(first.refresh_token), T + 1);
    await rejects(token(store, refreshForm(first.refresh_token), T + 2), 'invalid_grant');
    expect(await owner(store, second.access_token, T + 2)).toBeUndefined();
    await rejects(token(store, refreshForm(second.refresh_token), T + 3), 'invalid_grant');
  });

  it('sweeps expired tokens, so a long-lived connection stays a handful of documents', async () => {
    const { store, codeForm, refreshForm, newCode } = await registered();
    let pair = await token(store, codeForm(await newCode()), T);
    for (let hour = 1; hour <= 24 * 30; hour++) {
      pair = await token(store, refreshForm(pair.refresh_token), T + hour * ACCESS_TTL_MS);
    }
    // One live pair, plus the spent refresh tokens of the last day.
    expect(store.tokens.size).toBeLessThan(30);
    expect(await owner(store, pair.access_token, T + 24 * 30 * ACCESS_TTL_MS)).toBe('owner');
    await rejects(
      token(store, refreshForm(pair.refresh_token), T + 24 * 30 * ACCESS_TTL_MS + REFRESH_TTL_MS),
      'invalid_grant',
    );
  });

  it('Disconnect drops every token and code of the owner', async () => {
    const { store, codeForm, newCode } = await registered();
    const tokens = await token(store, codeForm(await newCode()), T);
    await newCode();
    expect(await store.revokeAll('owner')).toBe(4);
    expect(await owner(store, tokens.access_token)).toBeUndefined();
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
