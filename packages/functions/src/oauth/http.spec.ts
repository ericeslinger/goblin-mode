import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type HttpRequest, type OAuthDeps, handleOAuth } from './http';
import { memoryOAuthStore } from './memory-store';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function res() {
  const r = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    set(name: string, value: string) {
      r.headers[name.toLowerCase()] = value;
      return r;
    },
    json(body: unknown) {
      r.body = body;
    },
    end() {},
  };
  return r;
}

function req(method: string, path: string, over: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method,
    path,
    headers: { 'x-forwarded-host': 'notes.example.com', 'x-forwarded-proto': 'https' },
    query: {},
    body: undefined,
    ...over,
  };
}

function deps(over: Partial<OAuthDeps> = {}): OAuthDeps {
  return {
    store: memoryOAuthStore(),
    verifyIdToken: vi.fn(async (t: string) =>
      t === 'good' ? 'owner' : Promise.reject(new Error()),
    ),
    ownerUid: 'owner',
    now: () => 1_800_000_000_000,
    ...over,
  };
}

const call = async (d: OAuthDeps, r: HttpRequest) => {
  const out = res();
  await handleOAuth(d, r, out);
  return out;
};

describe('handleOAuth', () => {
  it('serves metadata naming the forwarded public origin', async () => {
    const out = await call(deps(), req('GET', '/.well-known/oauth-authorization-server'));
    expect(out.body).toMatchObject({ token_endpoint: 'https://notes.example.com/oauth/token' });
    const pr = await call(deps(), req('GET', '/.well-known/oauth-protected-resource/mcp'));
    expect(pr.body).toMatchObject({ resource: 'https://notes.example.com/mcp' });
  });

  it('runs register, consent, approve and token end to end', async () => {
    const d = deps();
    const reg = await call(
      d,
      req('POST', '/oauth/register', {
        body: { redirect_uris: [CALLBACK], client_name: 'Claude' },
      }),
    );
    expect(reg.statusCode).toBe(201);
    const clientId = (reg.body as { client_id: string }).client_id;
    const verifier = 'x'.repeat(50);
    const params = {
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 's1',
    };

    const consent = await call(d, req('GET', '/oauth/approve', { query: params }));
    expect(consent.body).toEqual({ client_name: 'Claude', redirect_origin: 'https://claude.ai' });

    const unsigned = await call(d, req('POST', '/oauth/approve', { body: params }));
    expect(unsigned.statusCode).toBe(401);
    const approved = await call(
      d,
      req('POST', '/oauth/approve', { body: params, headers: { authorization: 'Bearer good' } }),
    );
    const redirect = new URL((approved.body as { redirect: string }).redirect);
    expect(redirect.searchParams.get('state')).toBe('s1');

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: redirect.searchParams.get('code')!,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    }).toString();
    const tok = await call(d, req('POST', '/oauth/token', { body: form }));
    expect(tok.body).toMatchObject({ token_type: 'Bearer' });
    expect(tok.headers['cache-control']).toBe('no-store');
  });

  it('answers OAuth errors as JSON with their status', async () => {
    const out = await call(
      deps(),
      req('POST', '/oauth/register', { body: { redirect_uris: ['https://evil.example'] } }),
    );
    expect(out.statusCode).toBe(400);
    expect(out.body).toMatchObject({ error: 'invalid_redirect_uri' });
    expect((await call(deps(), req('GET', '/oauth/nope'))).statusCode).toBe(404);
  });

  it('revokes every token for the signed-in owner', async () => {
    const d = deps();
    const out = await call(
      d,
      req('POST', '/oauth/revoke', { headers: { authorization: 'Bearer good' } }),
    );
    expect(out.body).toEqual({ revoked: 0 });
  });
});
