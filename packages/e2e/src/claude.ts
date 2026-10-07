import type { APIRequestContext, Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/**
 * Connects Claude as claude.ai does (register, consent, code, token)
 * for the signed-in owner, and returns a way to call its MCP tools.
 * The full flow, step by step, is the claude.spec.ts journey. Leaves
 * the page at claude.ai's callback.
 */
export async function connectClaude(
  page: Page,
  /** Where the tool calls go from; Claude's are off the phone (offline journeys). */
  calls?: APIRequestContext,
): Promise<(name: string, args: object) => Promise<unknown>> {
  const api: APIRequestContext = page.request;
  const { client_id } = await (
    await api.post('/oauth/register', {
      data: { client_name: 'Claude', redirect_uris: [CALLBACK] },
    })
  ).json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let callback = '';
  await page.route('https://claude.ai/**', (route) => {
    callback = route.request().url();
    return route.fulfill({ status: 200, body: 'back at claude.ai' });
  });
  const query = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'e2e',
  });
  await page.goto(`/oauth/authorize?${query}`);
  await page.getByRole('button', { name: 'Allow' }).click();
  await page.waitForURL((url) => url.href.startsWith(CALLBACK));
  const code = new URL(callback).searchParams.get('code')!;
  const { access_token } = await (
    await api.post('/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        client_id,
        code,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
      },
    })
  ).json();
  let id = 0;
  return async (name, args) => {
    const res = await (calls ?? api).post('/mcp', {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        authorization: `Bearer ${access_token}`,
      },
      data: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } },
    });
    const { result } = await res.json();
    const text = (result.content as { text: string }[])[0].text;
    if (result.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };
}
