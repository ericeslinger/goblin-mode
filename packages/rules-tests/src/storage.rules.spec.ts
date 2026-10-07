import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

// Storage holds only attachments, owner-only, size and type checked.
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

beforeEach(() => env.clearStorage());
afterAll(() => env.cleanup());

const MB = 1024 * 1024;
const file = (bytes: number) => new Uint8Array(bytes);
const put = (who: 'owner' | 'intruder', path: string, bytes: number, contentType: string) =>
  env.authenticatedContext(who).storage().ref(path).put(file(bytes), { contentType }).then();

describe('storage.rules: attachments (#43)', () => {
  const path = 'users/owner/attachments/a1/kiln.jpg';

  it('lets the owner store, read and delete an image or a PDF under their attachments', async () => {
    await assertSucceeds(put('owner', path, 1000, 'image/jpeg'));
    await assertSucceeds(
      put('owner', 'users/owner/attachments/a2/paper.pdf', 1000, 'application/pdf'),
    );
    const owner = env.authenticatedContext('owner').storage();
    await assertSucceeds(owner.ref(path).getDownloadURL());
    await assertSucceeds(owner.ref(path).delete());
  });

  it('refuses files over 25 MB, other types, and other places', async () => {
    await assertFails(put('owner', path, 25 * MB + 1, 'image/jpeg'));
    await assertSucceeds(put('owner', path, 25 * MB, 'image/jpeg'));
    await assertFails(put('owner', path, 1000, 'text/html'));
    await assertFails(put('owner', path, 1000, 'image/svg+xml'));
    await assertFails(put('owner', 'users/owner/a.png', 1000, 'image/png'));
    await assertFails(put('owner', 'users/owner/attachments/a.png', 1000, 'image/png'));
  });

  it('keeps one owner out of another’s files', async () => {
    await assertSucceeds(put('owner', path, 1000, 'image/jpeg'));
    await assertFails(put('intruder', path, 1000, 'image/jpeg'));
    await assertFails(env.authenticatedContext('intruder').storage().ref(path).getDownloadURL());
    await assertFails(env.unauthenticatedContext().storage().ref(path).getDownloadURL());
  });
});

describe('storage.rules: everything else', () => {
  it('denies the owner reading or writing outside attachments', async () => {
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
