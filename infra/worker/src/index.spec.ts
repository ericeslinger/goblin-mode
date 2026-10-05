import { describe, expect, it } from 'vitest';
import { functionFor } from './index';

describe('functionFor', () => {
  it('routes server paths to their function', () => {
    expect(functionFor('/mcp')).toBe('mcp');
    expect(functionFor('/.well-known/oauth-authorization-server')).toBe('oauth');
    expect(functionFor('/oauth/token')).toBe('oauth');
    expect(functionFor('/api/health')).toBe('health');
  });

  it('leaves app routes to the static assets', () => {
    expect(functionFor('/')).toBeUndefined();
    expect(functionFor('/settings')).toBeUndefined();
    expect(functionFor('/oauth/authorize')).toBeUndefined();
    expect(functionFor('/mcpx')).toBeUndefined();
  });
});
