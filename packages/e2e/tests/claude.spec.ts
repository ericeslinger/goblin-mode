import AxeBuilder from '@axe-core/playwright';
import { createHash, randomBytes } from 'node:crypto';
import { expect, signInAs, test } from '../src/fixtures';
import { OWNER } from '../src/personas';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/** One JSON-RPC call to /mcp as claude.ai makes it. */
function mcpCall(token: string | undefined, method: string, params: object, id = 1) {
  return {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    data: { jsonrpc: '2.0', id, method, params },
  };
}

// The connector flow end to end, as claude.ai drives it: the e2e static
// server forwards /oauth and /mcp to the functions emulator, where
// OWNER_UID is this persona (scripts/e2e.sh).
test('Claude connects with OAuth, writes a note through MCP, and can be disconnected', async ({
  page,
}) => {
  await signInAs(page, OWNER);
  const api = page.request;

  // claude.ai has no MCP token yet: /mcp points it at the OAuth metadata.
  const anonymous = await api.post('/mcp', mcpCall(undefined, 'tools/list', {}));
  expect(anonymous.status()).toBe(401);
  expect(anonymous.headers()['www-authenticate']).toContain(
    '/.well-known/oauth-protected-resource',
  );
  const metadata = await (await api.get('/.well-known/oauth-authorization-server')).json();
  expect(metadata.authorization_endpoint).toMatch(/\/oauth\/authorize$/);

  const registered = await api.post('/oauth/register', {
    data: { client_name: 'Claude', redirect_uris: [CALLBACK] },
  });
  expect(registered.status()).toBe(201);
  const { client_id } = await registered.json();

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
    state: 'xyz',
  });
  await page.goto(`/oauth/authorize?${query}`);
  await expect(page.getByRole('heading', { name: 'Connect Claude' })).toBeVisible();
  await expect(page.getByText('wants to read and change your notes')).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect.poll(() => callback).toContain(CALLBACK);
  const back = new URL(callback);
  expect(back.searchParams.get('state')).toBe('xyz');

  const tokens = await (
    await api.post('/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        client_id,
        code: back.searchParams.get('code')!,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
      },
    })
  ).json();
  expect(tokens.token_type).toBe('Bearer');

  const listed = await (
    await api.post('/mcp', mcpCall(tokens.access_token, 'tools/list', {}))
  ).json();
  expect(listed.result.tools.map((t: { name: string }) => t.name)).toContain('create_note');
  const created = await (
    await api.post(
      '/mcp',
      mcpCall(tokens.access_token, 'tools/call', {
        name: 'create_note',
        arguments: { body: 'Filed by Claude\nfrom the chat about trains' },
      }),
    )
  ).json();
  expect(created.result.isError).toBeFalsy();

  await page.goto('/browse');
  await expect(page.getByRole('list', { name: 'Notes' })).toContainText('Filed by Claude');

  await page.getByRole('link', { name: 'Back' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText(/\/mcp$/)).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect Claude' }).click();
  await expect(page.getByText('Claude is disconnected.')).toBeVisible();
  const after = await api.post('/mcp', mcpCall(tokens.access_token, 'tools/list', {}));
  expect(after.status()).toBe(401);
});
