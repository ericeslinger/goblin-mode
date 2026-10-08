import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

// Runs inside `npm run e2e`, against the e2e Firestore emulator, under its
// own project id so it never touches journey data.
let env: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180').split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-mossgoblin-rules',
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

const now = () => firebase.firestore.Timestamp.now();

/** Shapes the generated validators accept, one per client-written path. */
const valid: Record<string, () => object> = {
  'users/owner/notes/n1': () => ({
    kind: 'text',
    body: 'buy eggs',
    title: 'buy eggs',
    titleSource: 'words',
    links: [],
    tags: [],
    archived: false,
    createdAt: now(),
    updatedAt: now(),
    updatedBy: 'user',
    deviceId: 'phone',
  }),
  'users/owner/reminders/r1': () => ({ text: 'call mum', status: 'open', createdBy: 'user' }),
  'users/owner/devices/d1': () => ({ token: 'fcm-token', updatedAt: now() }),
  'users/owner/settings/app': () => ({ theme: 'night', mode: 'dark', updatedAt: now() }),
  'users/owner/attachments/a1': () => ({
    kind: 'image',
    name: 'kiln.jpg',
    noteId: 'n1',
    path: 'users/owner/attachments/a1/kiln.jpg',
    contentType: 'image/jpeg',
    size: 120_000,
    toRead: false,
    read: false,
    createdAt: now(),
    updatedAt: now(),
    createdBy: 'user',
  }),
};

describe('client-written collections: notes, reminders, devices, settings, attachments', () => {
  for (const [path, shape] of Object.entries(valid)) {
    it(`${path}: the owner can create, read, update and delete`, async () => {
      await assertSucceeds(owner().doc(path).set(shape()));
      await assertSucceeds(owner().doc(path).get());
      await assertSucceeds(owner().doc(path).set(shape(), { merge: true }));
      await assertSucceeds(owner().doc(path).delete());
    });

    it(`${path}: another user and a signed-out client can do nothing`, async () => {
      await seed(path, shape());
      for (const db of [intruder(), anonymous()]) {
        await assertFails(db.doc(path).get());
        await assertFails(db.doc(path).set(shape()));
        await assertFails(db.doc(path).delete());
      }
    });

    it(`${path}: the owner cannot write a malformed document`, async () => {
      await assertFails(owner().doc(path).set({ x: 1 }));
      await assertFails(
        owner()
          .doc(path)
          .set({ ...shape(), surprise: true }),
      );
    });
  }

  it('checks each note field against the contract', async () => {
    const note = valid['users/owner/notes/n1'];
    const ref = owner().doc('users/owner/notes/n1');
    await assertFails(ref.set({ ...note(), kind: 'folder' }));
    await assertFails(ref.set({ ...note(), body: 42 }));
    await assertFails(ref.set({ ...note(), updatedAt: 'yesterday' }));
    await assertFails(ref.set({ ...note(), archived: 'no' }));
    const { deviceId: _dropped, ...missing } = note() as Record<string, unknown>;
    await assertFails(ref.set(missing));
    await assertSucceeds(ref.set({ ...note(), conceptType: 'person', synonyms: ['vik'] }));
    // Moods are concepts too (#40).
    await assertSucceeds(ref.set({ ...note(), kind: 'concept', conceptType: 'mood' }));
    await assertFails(ref.set({ ...note(), kind: 'concept', conceptType: 'feeling' }));
  });

  it('accepts a project with a parent, a kind and a known status (#41)', async () => {
    const note = valid['users/owner/notes/n1'];
    const ref = owner().doc('users/owner/notes/n1');
    const project = () => ({ ...note(), conceptType: 'project', parent: 'p0' });
    await assertSucceeds(ref.set({ ...project(), projectKind: 'build', projectStatus: 'active' }));
    await assertSucceeds(ref.set({ ...project(), projectKind: 'content', projectStatus: 'new' }));
    await assertFails(ref.set({ ...project(), projectStatus: 'someday' }));
    await assertFails(ref.set({ ...project(), projectKind: 'garden' }));
    await assertFails(ref.set({ ...project(), parent: 7 }));
  });

  it('accepts templates and notes made from them, with known modes only', async () => {
    const note = valid['users/owner/notes/n1'];
    const ref = owner().doc('users/owner/notes/n1');
    await assertSucceeds(ref.set({ ...note(), kind: 'template', templateMode: 'living' }));
    await assertSucceeds(ref.set({ ...note(), kind: 'template', templateMode: 'entry' }));
    await assertFails(ref.set({ ...note(), kind: 'template', templateMode: 'weekly' }));
    await assertSucceeds(ref.set({ ...note(), fromTemplate: 't1' }));
    await assertFails(ref.set({ ...note(), fromTemplate: 1 }));
    await assertSucceeds(ref.set({ ...note(), baseHash: '5-1a2b3c4d' }));
    await assertFails(ref.set({ ...note(), baseHash: 5 }));
  });

  it('lets the app settle a note with a merged server timestamp, and nothing else in it', async () => {
    const note = valid['users/owner/notes/n1'];
    const ref = owner().doc('users/owner/notes/n1');
    await assertSucceeds(ref.set(note()));
    await assertSucceeds(
      ref.set({ settledAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }),
    );
    await assertFails(ref.set({ settledAt: 'just now' }, { merge: true }));
  });

  it('checks attachments: a known kind, and the reading-queue flags', async () => {
    const attachment = valid['users/owner/attachments/a1'];
    const ref = owner().doc('users/owner/attachments/a1');
    await assertFails(ref.set({ ...attachment(), kind: 'video' }));
    await assertFails(ref.set({ ...attachment(), size: '120k' }));
    const { read: _read, ...unread } = attachment() as Record<string, unknown>;
    await assertFails(ref.set(unread));
    await assertSucceeds(
      ref.set({
        kind: 'link',
        name: 'A paper',
        url: 'https://example.org/paper',
        toRead: true,
        read: false,
        createdAt: now(),
        updatedAt: now(),
        createdBy: 'claude',
      }),
    );
    // Marked read after the server added its text (#45, #48).
    await assertSucceeds(
      ref.set({ ...attachment(), textPath: 'users/owner/attachments/a1/text_page.txt', pages: 3 }),
    );
    await assertSucceeds(ref.set({ read: true, updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ pages: 'three' }, { merge: true }));
    // Asking for a transcription (#47); the day's count is the server's.
    await assertSucceeds(ref.set({ transcribe: 'requested', updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ transcribe: 'please' }, { merge: true }));
    await assertFails(owner().doc('users/owner/usage/2026-10-08').set({ transcriptions: 0 }));
  });

  it('keeps settings to one doc, app, holding a known theme and mode', async () => {
    const settings = valid['users/owner/settings/app'];
    await assertFails(owner().doc('users/owner/settings/other').set(settings()));
    const ref = owner().doc('users/owner/settings/app');
    await assertFails(ref.set({ ...settings(), theme: 'neon' }));
    await assertFails(ref.set({ ...settings(), mode: 'auto' }));
    await assertSucceeds(
      ref.set({ ...settings(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
    );
  });

  it('accepts a server timestamp, as the app writes updatedAt', async () => {
    const note = valid['users/owner/notes/n1'];
    await assertSucceeds(
      owner()
        .doc('users/owner/notes/n1')
        .set({ ...note(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
    );
  });
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

describe('server-only: notes/replaced, the texts merges start from', () => {
  const path = 'users/owner/notes/n1/replaced/h1';
  it('not even the owner can read or write it', async () => {
    await seed(path);
    await assertFails(owner().doc(path).get());
    await assertFails(owner().doc(path).set({ bodies: [] }));
    await assertFails(owner().doc(path).delete());
    await assertFails(intruder().doc(path).get());
  });
});

describe('proposals: the owner only accepts or dismisses an open one', () => {
  const path = 'users/owner/proposals/p1';
  const proposal = (status = 'open') => ({
    kind: 'merge',
    reason: 'Same firing.',
    notes: [
      { id: 'a', title: 'Kiln log' },
      { id: 'b', title: 'Firing notes' },
    ],
    key: 'merge:a,b',
    status,
    createdAt: now(),
  });

  it('lets the owner accept or dismiss an open proposal, and read it', async () => {
    await seed(path, proposal());
    await assertSucceeds(owner().doc(path).get());
    await assertSucceeds(owner().doc(path).update({ status: 'accepted', decidedAt: now() }));
    await seed(path, proposal());
    await assertSucceeds(owner().doc(path).update({ status: 'dismissed', decidedAt: now() }));
  });

  it('refuses any other change, a decided proposal, and anyone else', async () => {
    await seed(path, proposal());
    await assertFails(owner().doc(path).update({ status: 'applied', decidedAt: now() }));
    await assertFails(owner().doc(path).update({ status: 'accepted' }));
    await assertFails(
      owner()
        .doc(path)
        .update({ status: 'accepted', decidedAt: now(), notes: [{ id: 'x', title: 'x' }] }),
    );
    await assertFails(intruder().doc(path).get());
    await assertFails(intruder().doc(path).update({ status: 'accepted', decidedAt: now() }));
    await assertFails(anonymous().doc(path).get());
    await seed(path, proposal('dismissed'));
    await assertFails(owner().doc(path).update({ status: 'accepted', decidedAt: now() }));
  });

  it('refuses creating or deleting proposals from the app', async () => {
    await assertFails(owner().doc(path).set(proposal()));
    await seed(path, proposal());
    await assertFails(owner().doc(path).delete());
  });
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
    // Where the oauth function keeps clients, codes and token hashes.
    for (const path of ['oauth/clients/items/c1', 'oauth/codes/items/h', 'oauth/tokens/items/h']) {
      await seed(path);
      await assertFails(owner().doc(path).get());
      await assertFails(owner().doc(path).set({ x: 1 }));
      await assertFails(
        owner()
          .collection(path.slice(0, path.lastIndexOf('/')))
          .get(),
      );
    }
  });
});
