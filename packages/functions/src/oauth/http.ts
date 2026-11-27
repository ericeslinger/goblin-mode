import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import {
  type AuthorizeRequest,
  OAuthError,
  type OAuthStore,
  approve,
  authServerMetadata,
  checkAuthorize,
  protectedResourceMetadata,
  register,
  token,
} from './core';
import { firestoreOAuthStore } from './firestore-store';

/** The minimal request and response the handler uses (Express-shaped). */
export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body: unknown;
}
export interface HttpResponse {
  status(code: number): HttpResponse;
  set(name: string, value: string): HttpResponse;
  json(body: unknown): void;
  end(): void;
}

export interface OAuthDeps {
  store: OAuthStore;
  /** The uid in a Firebase ID token, after verifying it. */
  verifyIdToken(idToken: string): Promise<string>;
  ownerUid: string | undefined;
  now(): number;
}

const header = (req: HttpRequest, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * The public origin: the app's own domain, which the Worker (and the e2e
 * static server) forwards, so the issuer and every endpoint name it.
 */
export function publicOrigin(req: HttpRequest): string {
  const host = header(req, 'x-forwarded-host') ?? header(req, 'host') ?? 'localhost';
  const proto = header(req, 'x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function authorizeRequest(src: Record<string, unknown>): AuthorizeRequest {
  return {
    clientId: str(src['client_id']) ?? '',
    redirectUri: str(src['redirect_uri']) ?? '',
    codeChallenge: str(src['code_challenge']) ?? '',
    codeChallengeMethod: str(src['code_challenge_method']) ?? '',
    state: str(src['state']),
    resource: str(src['resource']),
  };
}

function formOf(body: unknown): Record<string, string | undefined> {
  if (typeof body === 'string') return Object.fromEntries(new URLSearchParams(body));
  if (body && typeof body === 'object') {
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, str(v)]));
  }
  return {};
}

async function idTokenUid(deps: OAuthDeps, req: HttpRequest): Promise<string> {
  const match = /^Bearer\s+(\S+)$/i.exec(header(req, 'authorization') ?? '');
  if (!match) throw new OAuthError('access_denied', 'sign in first', 401);
  try {
    return await deps.verifyIdToken(match[1]);
  } catch {
    throw new OAuthError('access_denied', 'the sign-in has expired; sign in again', 401);
  }
}

/**
 * What a registration asked for, for the log: its redirect URIs and the
 * few fields that decide how a client signs in, each cut short, and the
 * names of whatever else it sent.
 */
export function registrationAsked(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return { body: typeof body };
  const b = body as Record<string, unknown>;
  const short = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : typeof v);
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 10).map(short) : short(v));
  return {
    redirect_uris: list(b['redirect_uris']),
    token_endpoint_auth_method: short(b['token_endpoint_auth_method']),
    grant_types: list(b['grant_types']),
    response_types: list(b['response_types']),
    client_name: short(b['client_name']),
    fields: Object.keys(b)
      .slice(0, 30)
      .map((k) => k.slice(0, 60)),
  };
}

/** Routes one request to the OAuth endpoints. */
export async function handleOAuth(deps: OAuthDeps, req: HttpRequest, res: HttpResponse) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'authorization, content-type');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const origin = publicOrigin(req);
  const route = `${req.method} ${req.path}`;
  try {
    switch (route) {
      case 'GET /.well-known/oauth-authorization-server':
        return res.json(authServerMetadata(origin));
      case 'GET /.well-known/oauth-protected-resource':
      case 'GET /.well-known/oauth-protected-resource/mcp':
        return res.json(protectedResourceMetadata(origin));
      case 'POST /oauth/register': {
        const client = await register(
          deps.store,
          (req.body ?? {}) as Record<string, unknown>,
          deps.now(),
        );
        return res.status(201).json({
          client_id: client.clientId,
          client_name: client.clientName,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        });
      }
      case 'GET /oauth/approve': {
        // The consent page asks who is asking before Eric approves.
        const client = await checkAuthorize(
          deps.store,
          authorizeRequest(req.query),
          `${origin}/mcp`,
        );
        return res.json({
          client_name: client.clientName,
          redirect_origin: new URL(authorizeRequest(req.query).redirectUri).origin,
        });
      }
      case 'POST /oauth/approve': {
        const uid = await idTokenUid(deps, req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const redirect = await approve(
          deps.store,
          authorizeRequest(body),
          `${origin}/mcp`,
          uid,
          deps.ownerUid,
          deps.now(),
        );
        return res.json({ redirect });
      }
      case 'POST /oauth/token':
        return res.json(await token(deps.store, formOf(req.body), deps.now()));
      case 'POST /oauth/revoke': {
        // Disconnect Claude: the owner, signed in, drops every token.
        const uid = await idTokenUid(deps, req);
        return res.json({ revoked: await deps.store.revokeAll(uid) });
      }
      default:
        return res.status(404).json({ error: 'not_found' });
    }
  } catch (err) {
    if (err instanceof OAuthError) {
      // A refused registration says what was asked (2026-11-27): Gemini
      // on the web was refused and nothing recorded why. Only the named
      // fields are logged, each cut short, and no header but the agent.
      if (route === 'POST /oauth/register') {
        logger.warn('oauth: registration refused', {
          error: err.error,
          asked: registrationAsked(req.body),
          agent: (header(req, 'user-agent') ?? '').slice(0, 200),
        });
      }
      return res.status(err.status).json({ error: err.error, error_description: err.description });
    }
    logger.error('oauth', err);
    return res.status(500).json({ error: 'server_error' });
  }
}

/** The OAuth endpoints, proxied by the Worker on the app's domain. */
export const oauth = onRequest((req, res) =>
  handleOAuth(
    {
      store: firestoreOAuthStore(getFirestore()),
      verifyIdToken: async (t) => (await getAuth().verifyIdToken(t)).uid,
      ownerUid: process.env['OWNER_UID'] || undefined,
      now: () => Date.now(),
    },
    req,
    res,
  ),
);
