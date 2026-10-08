import { describe, expect, it } from 'vitest';
import { functionFor, shareFallback } from './index';

describe('functionFor', () => {
  it('routes server paths to their function', () => {
    expect(functionFor('/mcp')).toBe('mcp');
    expect(functionFor('/.well-known/oauth-authorization-server')).toBe('oauth');
    expect(functionFor('/oauth/token')).toBe('oauth');
    expect(functionFor('/oauth/revoke')).toBe('oauth');
    expect(functionFor('/api/health')).toBe('health');
  });

  it('leaves app routes to the static assets', () => {
    expect(functionFor('/')).toBeUndefined();
    expect(functionFor('/settings')).toBeUndefined();
    expect(functionFor('/oauth/authorize')).toBeUndefined();
    expect(functionFor('/mcpx')).toBeUndefined();
  });
});

describe('shareFallback', () => {
  it('sends a share the service worker missed on to the app, saying files were lost', async () => {
    const form = new FormData();
    form.set('title', 'Seeds');
    form.set('text', 'what if');
    form.set('url', ' ');
    form.append('files', new File(['x'], 'a.png', { type: 'image/png' }));
    const res = await shareFallback(
      new Request('https://notes.example/share', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      'https://notes.example/?title=Seeds&text=what+if&shared=lost',
    );
  });
});
