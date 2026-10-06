import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { firestoreOAuthStore } from './firestore-store';

// Runs inside `npm run e2e`, against the e2e Firestore emulator.
const PROJECT = 'demo-goblin-mode-oauth';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'oauth-store-spec');
let db: Firestore;

beforeAll(() => {
  process.env['FIRESTORE_EMULATOR_HOST'] = HOST;
  db = getFirestore(app);
});
beforeEach(async () => {
  const res = await fetch(
    `http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`could not clear the emulator: ${res.status}`);
});
afterAll(() => deleteApp(app));

describe('firestoreOAuthStore', () => {
  it('keeps clients, takes a code once, and revokes all of one uid’s tokens', async () => {
    const store = firestoreOAuthStore(db);
    const client = {
      clientId: 'c1',
      clientName: 'Claude',
      redirectUris: ['https://claude.ai/cb'],
      createdAt: 1,
    };
    await store.saveClient(client);
    expect(await store.client('c1')).toEqual(client);
    expect(await store.client('nope')).toBeUndefined();

    const grant = {
      clientId: 'c1',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: 'x',
      uid: 'owner',
      expiresAt: 9,
    };
    await store.saveCode('h1', grant);
    expect(await store.takeCode('h1')).toEqual(grant);
    expect(await store.takeCode('h1')).toBeUndefined();

    await store.saveToken('a', { kind: 'access', clientId: 'c1', uid: 'owner', expiresAt: 9 });
    await store.saveToken('r', { kind: 'refresh', clientId: 'c1', uid: 'owner', expiresAt: 9 });
    await store.saveToken('o', { kind: 'access', clientId: 'c1', uid: 'other', expiresAt: 9 });
    expect(await store.takeToken('r')).toMatchObject({ kind: 'refresh' });
    expect(await store.revokeAll('owner')).toBe(1);
    expect(await store.token('a')).toBeUndefined();
    expect(await store.token('o')).toMatchObject({ uid: 'other' });
  });
});
