import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

// Runs inside `npm run e2e`, against the e2e Firestore emulator.
let env: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180').split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-goblin-mode-rules',
    firestore: {
      rules: readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8'),
      host,
      port: Number(port),
    },
  });
});

beforeEach(() => env.clearFirestore());
afterAll(() => env.cleanup());

describe('firestore.rules', () => {
  it('lets the owner read and write their notes', async () => {
    const db = env.authenticatedContext('owner').firestore();
    await assertSucceeds(db.doc('users/owner/notes/n1').set({ body: 'hi' }));
    await assertSucceeds(db.doc('users/owner/notes/n1').get());
  });

  it("refuses another user's notes", async () => {
    const db = env.authenticatedContext('intruder').firestore();
    await assertFails(db.doc('users/owner/notes/n1').get());
    await assertFails(db.doc('users/owner/notes/n1').set({ body: 'x' }));
  });

  it('refuses signed-out access and anything outside users/', async () => {
    await assertFails(env.unauthenticatedContext().firestore().doc('users/owner/notes/n1').get());
    const owner = env.authenticatedContext('owner').firestore();
    await assertFails(owner.doc('oauth/clients').get());
  });
});
