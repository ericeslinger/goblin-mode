import {
  RulesTestEnvironment,
  assertFails,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';

// Storage is deny-all until attachments arrive; these pin that down.
let env: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env['FIREBASE_STORAGE_EMULATOR_HOST'] ?? '127.0.0.1:9198').split(
    ':',
  );
  env = await initializeTestEnvironment({
    projectId: 'demo-mossgoblin-rules',
    storage: {
      rules: readFileSync(new URL('../../../storage.rules', import.meta.url), 'utf8'),
      host,
      port: Number(port),
    },
  });
});

afterAll(() => env.cleanup());

describe('storage.rules', () => {
  it('denies the owner reading or writing their own path', async () => {
    const storage = env.authenticatedContext('owner').storage();
    await assertFails(storage.ref('users/owner/a.png').getDownloadURL());
    await assertFails(storage.ref('users/owner/a.png').putString('x').then());
  });

  it('denies a signed-out client', async () => {
    const storage = env.unauthenticatedContext().storage();
    await assertFails(storage.ref('users/owner/a.png').getDownloadURL());
    await assertFails(storage.ref('anything').putString('x').then());
  });
});
