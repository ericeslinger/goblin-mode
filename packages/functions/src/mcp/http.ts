import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type OAuthStore, authenticate } from '../oauth/core';
import { firestoreOAuthStore } from '../oauth/firestore-store';
import { publicOrigin } from '../oauth/http';
import { buildServer } from './server';
import { NotesTools } from './tools';

export interface McpDeps {
  store: OAuthStore;
  ownerUid: string | undefined;
  now(): number;
  toolsFor(uid: string): NotesTools;
}

type Req = IncomingMessage & {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
};
type Res = ServerResponse & {
  status(code: number): Res;
  set(name: string, value: string): Res;
  json(body: unknown): void;
};

/**
 * MCP over Streamable HTTP, stateless: each POST builds a server for the
 * owner the bearer token belongs to. No token, or anyone else's, gets a
 * 401 that points claude.ai at the OAuth metadata.
 */
export async function handleMcp(deps: McpDeps, req: Req, res: Res): Promise<void> {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'authorization, content-type, mcp-protocol-version');
  res.set('Access-Control-Expose-Headers', 'www-authenticate');
  if (req.method === 'OPTIONS') return void res.status(204).end();

  const auth = req.headers['authorization'];
  const uid = await authenticate(deps.store, Array.isArray(auth) ? auth[0] : auth, deps.now());
  if (!uid || !deps.ownerUid || uid !== deps.ownerUid) {
    const metadata = `${publicOrigin(req)}/.well-known/oauth-protected-resource`;
    res.set('WWW-Authenticate', `Bearer resource_metadata="${metadata}"`);
    return void res.status(401).json({ error: 'invalid_token' });
  }
  if (req.method !== 'POST') {
    res.set('Allow', 'POST');
    return void res.status(405).json({ error: 'stateless server: POST only' });
  }

  const server = buildServer(deps.toolsFor(uid));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/** The MCP endpoint, proxied by the Worker at /mcp on the app's domain. */
export const mcp = onRequest((req, res) => {
  const db = getFirestore();
  return handleMcp(
    {
      store: firestoreOAuthStore(db),
      ownerUid: process.env['OWNER_UID'] || undefined,
      now: () => Date.now(),
      toolsFor: (uid) => new NotesTools(db, uid),
    },
    req as unknown as Req,
    res as unknown as Res,
  );
});
