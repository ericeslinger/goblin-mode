import { describe, expect, it } from 'vitest';
import { hash } from '../oauth/core';
import { memoryOAuthStore } from '../oauth/memory-store';
import { contextOrNone, handleMcp, isInitialize } from './http';
import type { NotesTools } from './tools';

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
    on() {},
  };
  return r;
}

const T = 1_800_000_000_000;

async function call(authorization: string | undefined, method = 'POST') {
  const store = memoryOAuthStore();
  await store.saveToken(hash('owner-token'), {
    kind: 'access',
    clientId: 'c',
    uid: 'owner',
    family: 'f',
    expiresAt: T + 1,
  });
  await store.saveToken(hash('other-token'), {
    kind: 'access',
    clientId: 'c',
    uid: 'someone',
    family: 'g',
    expiresAt: T + 1,
  });
  const out = res();
  await handleMcp(
    { store, ownerUid: 'owner', now: () => T, toolsFor: () => ({}) as NotesTools },
    {
      method,
      path: '/mcp',
      body: {},
      query: {},
      headers: {
        authorization,
        'x-forwarded-host': 'notes.example.com',
        'x-forwarded-proto': 'https',
      },
    } as never,
    out as never,
  );
  return out;
}

describe('contextOrNone', () => {
  it('gives no context, not an error, when the note cannot be read (review on #123)', async () => {
    const failing = {
      getContext: async () => {
        throw new Error('firestore down');
      },
    } as unknown as NotesTools;
    expect(await contextOrNone(failing)).toBe('');
    const told = {
      getContext: async () => ({ text: 'Fish on Wednesdays.' }),
    } as unknown as NotesTools;
    expect(await contextOrNone(told)).toBe('Fish on Wednesdays.');
  });
});

describe('isInitialize', () => {
  it('finds an initialize request, alone or in a batch (#113)', () => {
    expect(isInitialize({ jsonrpc: '2.0', id: 1, method: 'initialize' })).toBe(true);
    expect(isInitialize([{ method: 'tools/list' }, { method: 'initialize' }])).toBe(true);
    expect(isInitialize({ method: 'tools/call' })).toBe(false);
    expect(isInitialize(null)).toBe(false);
  });
});

describe('handleMcp', () => {
  it('sends anyone without a valid owner token to the OAuth metadata', async () => {
    for (const auth of [undefined, 'Bearer nope', 'Bearer other-token']) {
      const out = await call(auth);
      expect(out.statusCode).toBe(401);
      expect(out.headers['www-authenticate']).toBe(
        'Bearer resource_metadata="https://notes.example.com/.well-known/oauth-protected-resource"',
      );
    }
  });

  it('is stateless: the owner gets 405 for anything but POST', async () => {
    const out = await call('Bearer owner-token', 'GET');
    expect(out.statusCode).toBe(405);
  });
});
