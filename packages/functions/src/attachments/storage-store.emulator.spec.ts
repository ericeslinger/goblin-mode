import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { Bucket } from '@google-cloud/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { removeFiles, storageStore } from './storage-store';

// Runs inside `npm run e2e`, against the e2e Firestore and Storage
// emulators, under its own project id and bucket.
const PROJECT = 'demo-mossgoblin-files';
const FIRESTORE = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const STORAGE = process.env['FIREBASE_STORAGE_EMULATOR_HOST'] ?? '127.0.0.1:9198';
const app = initializeApp(
  { projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` },
  'files-store-spec',
);
let db: Firestore;
let bucket: Bucket;

beforeAll(() => {
  process.env['FIRESTORE_EMULATOR_HOST'] = FIRESTORE;
  process.env['FIREBASE_STORAGE_EMULATOR_HOST'] = STORAGE;
  db = getFirestore(app);
  bucket = getStorage(app).bucket();
});
beforeEach(async () => {
  await fetch(`http://${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  await bucket.deleteFiles({ prefix: 'users/' }).catch(() => undefined);
});
afterAll(() => deleteApp(app));

const dir = 'users/u1/attachments/a1';

describe('storageStore', () => {
  it('reads heads and files, writes a thumbnail, and names it on the record', async () => {
    const store = storageStore(bucket, db);
    await bucket.file(`${dir}/menu.jpg`).save(Buffer.from('0123456789abcdef-rest'), {
      contentType: 'image/jpeg',
    });
    expect(Buffer.from(await store.head(`${dir}/menu.jpg`, 4)).toString()).toBe('0123');
    await store.write(`${dir}/thumb_menu.webp`, Uint8Array.from([1, 2]), 'image/webp');
    const [meta] = await bucket.file(`${dir}/thumb_menu.webp`).getMetadata();
    expect(meta.contentType).toBe('image/webp');

    // Before the phone's record lands, and after: neither loses the other.
    await store.setThumb('u1', 'a1', `${dir}/thumb_menu.webp`);
    await db.doc(`${dir}`).set({ kind: 'image', name: 'menu.jpg' }, { merge: true });
    expect((await db.doc(dir).get()).data()).toMatchObject({
      kind: 'image',
      thumbPath: `${dir}/thumb_menu.webp`,
    });
  });

  it('removes a file, and every file of a deleted attachment', async () => {
    const store = storageStore(bucket, db);
    await bucket.file(`${dir}/menu.jpg`).save(Buffer.from('x'));
    await bucket.file(`${dir}/thumb_menu.webp`).save(Buffer.from('y'));
    await bucket.file('users/u1/attachments/a2/other.jpg').save(Buffer.from('z'));
    await store.remove(`${dir}/nothing-here.jpg`);
    await removeFiles(bucket, 'u1', 'a1');
    const [left] = await bucket.getFiles({ prefix: 'users/u1/' });
    expect(left.map((f) => f.name)).toEqual(['users/u1/attachments/a2/other.jpg']);
  });
});
