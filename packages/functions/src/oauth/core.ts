// The OAuth 2.1 authorization server claude.ai's custom connectors sign
// in through (DESIGN.md, MCP server): dynamic client registration, the
// authorization code flow with PKCE (S256 only), refresh token rotation.
// The only identity is the owner's Firebase sign-in, checked at approve.
// Pure over an OAuthStore; codes and tokens are stored only as hashes.
import { createHash, randomBytes } from 'node:crypto';

/** Where a registered client may send the code back (claude.ai's callback). */
export const ALLOWED_REDIRECT_ORIGINS = ['https://claude.ai', 'https://claude.com'];

export const CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const SCOPE = 'notes';

export interface Client {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

/** A spent code or refresh token is kept this long to spot a replay. */
export const SPENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Every code and token from one approval shares a `family`. A refresh
 * replaces the family's access token; a replayed code or refresh token
 * (someone else has a copy) revokes the whole family.
 */
export interface CodeGrant {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  uid: string;
  family: string;
  expiresAt: number;
  spent?: boolean;
}

export interface TokenGrant {
  kind: 'access' | 'refresh';
  clientId: string;
  uid: string;
  family: string;
  expiresAt: number;
  spent?: boolean;
}

/** What spending a one-time secret found; `reused` means it was spent before. */
export type Spent<T> = { grant: T; reused: boolean } | undefined;

export interface OAuthStore {
  saveClient(client: Client): Promise<void>;
  client(clientId: string): Promise<Client | undefined>;
  saveCode(hash: string, grant: CodeGrant): Promise<void>;
  /**
   * Marks a code spent in one step (kept until `keepUntil`, to spot a
   * replay) and returns it as it was, or says it was already spent.
   */
  spendCode(hash: string, keepUntil: number): Promise<Spent<CodeGrant>>;
  saveToken(hash: string, grant: TokenGrant): Promise<void>;
  token(hash: string): Promise<TokenGrant | undefined>;
  /** As spendCode, for refresh tokens only: anything else is left alone. */
  spendRefresh(hash: string, keepUntil: number): Promise<Spent<TokenGrant>>;
  /** Deletes a family's tokens, or only its access tokens. */
  deleteFamily(family: string, kind?: TokenGrant['kind']): Promise<number>;
  /** Deletes every code and token of this uid (Disconnect Claude). */
  revokeAll(uid: string): Promise<number>;
  /** Deletes this uid's codes and tokens that have expired. */
  sweep(uid: string, now: number): Promise<void>;
}

/** An OAuth error response: `error` per RFC 6749, with its HTTP status. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

export const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');

/** S256: base64url(sha256(verifier)) must equal the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}

export function authServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
  };
}

function allowedRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string') return false;
  try {
    const url = new URL(uri);
    return ALLOWED_REDIRECT_ORIGINS.includes(url.origin) && !url.hash;
  } catch {
    return false;
  }
}

/** RFC 7591 registration of a public client (no secret). */
export async function register(
  store: OAuthStore,
  body: Record<string, unknown>,
  now: number,
): Promise<Client> {
  const uris = body['redirect_uris'];
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(allowedRedirect)) {
    throw new OAuthError(
      'invalid_redirect_uri',
      `redirect_uris must be on ${ALLOWED_REDIRECT_ORIGINS.join(' or ')}`,
    );
  }
  const name = typeof body['client_name'] === 'string' ? body['client_name'].slice(0, 100) : '';
  const client: Client = {
    clientId: newSecret(),
    clientName: name || 'Claude',
    redirectUris: uris as string[],
    createdAt: now,
  };
  await store.saveClient(client);
  return client;
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
  resource?: string;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/**
 * Checks an authorize request before anyone is asked to approve it. A
 * `resource` (RFC 8707) must be this server's MCP endpoint, the only
 * thing its tokens are good for.
 */
export async function checkAuthorize(
  store: OAuthStore,
  req: AuthorizeRequest,
  resource: string,
): Promise<Client> {
  if (req.resource && trimSlash(req.resource) !== trimSlash(resource)) {
    throw new OAuthError('invalid_target', `this server only grants access to ${resource}`);
  }
  const client = await store.client(req.clientId);
  if (!client) throw new OAuthError('invalid_client', 'unknown client');
  if (!client.redirectUris.includes(req.redirectUri)) {
    throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
  }
  if (req.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(req.codeChallenge)) {
    throw new OAuthError('invalid_request', 'PKCE with S256 is required');
  }
  return client;
}

/**
 * The owner approved: issue a one-time code and say where to send it.
 * `uid` comes from a verified Firebase ID token; only `ownerUid` passes.
 */
export async function approve(
  store: OAuthStore,
  req: AuthorizeRequest,
  resource: string,
  uid: string,
  ownerUid: string | undefined,
  now: number,
): Promise<string> {
  await checkAuthorize(store, req, resource);
  if (!ownerUid || uid !== ownerUid) {
    throw new OAuthError('access_denied', 'only the owner can connect Claude', 403);
  }
  const code = newSecret();
  await store.saveCode(hash(code), {
    clientId: req.clientId,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    uid,
    family: newSecret(),
    expiresAt: now + CODE_TTL_MS,
  });
  const url = new URL(req.redirectUri);
  url.searchParams.set('code', code);
  if (req.state) url.searchParams.set('state', req.state);
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** A new access and refresh token in `family`; expired ones are swept first. */
async function issueTokens(
  store: OAuthStore,
  clientId: string,
  uid: string,
  family: string,
  now: number,
): Promise<TokenResponse> {
  await store.sweep(uid, now);
  const access = newSecret();
  const refresh = newSecret();
  await store.saveToken(hash(access), {
    kind: 'access',
    clientId,
    uid,
    family,
    expiresAt: now + ACCESS_TTL_MS,
  });
  await store.saveToken(hash(refresh), {
    kind: 'refresh',
    clientId,
    uid,
    family,
    expiresAt: now + REFRESH_TTL_MS,
  });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    scope: SCOPE,
  };
}

/** A replay: someone else has a copy, so nothing from this approval stands. */
async function replayed(store: OAuthStore, family: string): Promise<never> {
  await store.deleteFamily(family);
  throw new OAuthError('invalid_grant', 'already used; every token from it is revoked');
}

/** The token endpoint: authorization_code (with PKCE) or refresh_token. */
export async function token(
  store: OAuthStore,
  form: Record<string, string | undefined>,
  now: number,
): Promise<TokenResponse> {
  const clientId = form['client_id'];
  if (!clientId || !(await store.client(clientId))) {
    throw new OAuthError('invalid_client', 'unknown client', 401);
  }
  const keepUntil = now + SPENT_RETENTION_MS;
  if (form['grant_type'] === 'authorization_code') {
    const code = form['code'];
    const spent = code ? await store.spendCode(hash(code), keepUntil) : undefined;
    if (spent?.reused) return replayed(store, spent.grant.family);
    const grant = spent?.grant;
    if (
      !grant ||
      grant.expiresAt <= now ||
      grant.clientId !== clientId ||
      grant.redirectUri !== form['redirect_uri'] ||
      !form['code_verifier'] ||
      !pkceMatches(form['code_verifier'], grant.codeChallenge)
    ) {
      throw new OAuthError('invalid_grant', 'the code is invalid, expired or unverified');
    }
    return issueTokens(store, clientId, grant.uid, grant.family, now);
  }
  if (form['grant_type'] === 'refresh_token') {
    const refresh = form['refresh_token'];
    const spent = refresh ? await store.spendRefresh(hash(refresh), keepUntil) : undefined;
    if (spent?.reused) return replayed(store, spent.grant.family);
    const grant = spent?.grant;
    if (!grant || grant.expiresAt <= now || grant.clientId !== clientId) {
      throw new OAuthError('invalid_grant', 'the refresh token is invalid or expired');
    }
    // The old access token goes with the refresh token it came with.
    await store.deleteFamily(grant.family, 'access');
    return issueTokens(store, clientId, grant.uid, grant.family, now);
  }
  throw new OAuthError('unsupported_grant_type', 'use authorization_code or refresh_token');
}

/** The uid a bearer access token acts for, or undefined. */
export async function authenticate(
  store: OAuthStore,
  header: string | undefined,
  now: number,
): Promise<string | undefined> {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!match) return undefined;
  const grant = await store.token(hash(match[1]));
  if (!grant || grant.kind !== 'access' || grant.spent || grant.expiresAt <= now) return undefined;
  return grant.uid;
}
