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

const access = (uid: string, family: string, expiresAt = 100) =>
  ({ kind: 'access', clientId: 'c1', uid, family, expiresAt }) as const;

describe('firestoreOAuthStore', () => {
  it('keeps clients, and spends a code once, reporting a replay', async () => {
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
      family: 'f',
      expiresAt: 9,
    };
    await store.saveCode('h1', grant);
    expect(await store.spendCode('h1', 50)).toEqual({ grant, reused: false });
    expect(await store.spendCode('h1', 50)).toMatchObject({ reused: true, grant: { family: 'f' } });
    expect(await store.spendCode('nope', 50)).toBeUndefined();
  });

  it('spends refresh tokens only, and deletes a family or its access tokens', async () => {
    const store = firestoreOAuthStore(db);
    await store.saveToken('a', access('owner', 'f'));
    await store.saveToken('r', { ...access('owner', 'f'), kind: 'refresh' });
    await store.saveToken('x', access('owner', 'other'));
    expect(await store.spendRefresh('a', 50)).toBeUndefined();
    expect(await store.token('a')).toMatchObject({ kind: 'access' });
    expect(await store.spendRefresh('r', 50)).toMatchObject({ reused: false });

    expect(await store.deleteFamily('f', 'access')).toBe(1);
    expect(await store.token('r')).toMatchObject({ spent: true, expiresAt: 50 });
    expect(await store.deleteFamily('f')).toBe(1);
    expect(await store.token('x')).toBeTruthy();
  });

  it('sweeps one owner’s expired tokens and codes, leaving live ones', async () => {
    const store = firestoreOAuthStore(db);
    await store.saveToken('old', access('owner', 'f', 10));
    await store.saveToken('live', access('owner', 'f', 1000));
    await store.saveToken('theirs', access('other', 'g', 10));
    await store.sweep('owner', 100);
    expect(await store.token('old')).toBeUndefined();
    expect(await store.token('live')).toBeTruthy();
    expect(await store.token('theirs')).toBeTruthy();
  });

  it('revokes more tokens than one batch can hold', async () => {
    const store = firestoreOAuthStore(db);
    const writer = db.bulkWriter();
    for (let i = 0; i < 650; i++) {
      void writer.set(db.doc(`oauth/tokens/items/t${i}`), access('owner', `f${i % 3}`));
    }
    await writer.close();
    await store.saveToken('other', access('someone', 'g'));
    expect(await store.revokeAll('owner')).toBe(650);
    expect(await store.token('t1')).toBeUndefined();
    expect(await store.token('other')).toBeTruthy();
  });
});
