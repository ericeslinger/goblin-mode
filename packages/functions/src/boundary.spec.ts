import { describe, expect, it, vi } from 'vitest';

// The deployed surface is an API: the Worker routes to these names, so a
// rename breaks production without a type error. Adding a function means
// extending this table in the same commit.
const EXPORTS = ['health', 'mcp', 'noteHistory', 'noteTitle', 'oauth', 'sendDuePush'];

vi.mock('firebase-admin/app', () => ({ initializeApp: vi.fn() }));

describe('functions boundary', () => {
  it('exports exactly the registered functions', async () => {
    const mod = await import('./index');
    expect(Object.keys(mod).sort()).toEqual([...EXPORTS].sort());
  });
});
