import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

// Runs inside `npm run e2e`, against the e2e Firestore emulator, under its
// own project id so it never touches journey data.
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

const owner = () => env.authenticatedContext('owner').firestore();
const intruder = () => env.authenticatedContext('intruder').firestore();
const anonymous = () => env.unauthenticatedContext().firestore();

/** Seeds a document bypassing rules, for read and delete checks. */
async function seed(path: string, data: object = { x: 1 }): Promise<void> {
  await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(path).set(data));
}

describe('client-written collections: notes, reminders, devices', () => {
  for (const path of [
    'users/owner/notes/n1',
    'users/owner/reminders/r1',
    'users/owner/devices/d1',
  ]) {
    it(`${path}: the owner can create, read, update and delete`, async () => {
      await assertSucceeds(owner().doc(path).set({ x: 1 }));
      await assertSucceeds(owner().doc(path).get());
      await assertSucceeds(owner().doc(path).update({ x: 2 }));
      await assertSucceeds(owner().doc(path).delete());
    });

    it(`${path}: another user and a signed-out client can do nothing`, async () => {
      await seed(path);
      for (const db of [intruder(), anonymous()]) {
        await assertFails(db.doc(path).get());
        await assertFails(db.doc(path).set({ x: 3 }));
        await assertFails(db.doc(path).delete());
      }
    });
  }
});

describe('function-only collections: notes/history, activity', () => {
  for (const path of ['users/owner/notes/n1/history/v1', 'users/owner/activity/run1']) {
    it(`${path}: the owner can read but not write or delete`, async () => {
      await seed(path);
      await assertSucceeds(owner().doc(path).get());
      await assertFails(owner().doc(path).set({ x: 2 }));
      await assertFails(owner().doc(path).delete());
    });

    it(`${path}: nobody else can read`, async () => {
      await seed(path);
      await assertFails(intruder().doc(path).get());
      await assertFails(anonymous().doc(path).get());
    });
  }
});

describe('everything else is denied', () => {
  it('denies unknown collections under the owner', async () => {
    await assertFails(owner().doc('users/owner/secrets/s1').set({ x: 1 }));
    await assertFails(owner().doc('users/owner/notes/n1/other/o1').set({ x: 1 }));
  });

  it('lets the owner read but not write their user document', async () => {
    await seed('users/owner');
    await assertSucceeds(owner().doc('users/owner').get());
    await assertFails(owner().doc('users/owner').set({ admin: true }));
  });

  it('denies oauth/ to every client, owner included', async () => {
    await seed('oauth/clients');
    await assertFails(owner().doc('oauth/clients').get());
    await assertFails(owner().doc('oauth/clients').set({ x: 1 }));
  });
});
