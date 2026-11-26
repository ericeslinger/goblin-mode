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
  'users/owner/settings/modules': () => ({ projects: { enabled: true }, updatedAt: now() }),
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
  'users/owner/feeds/f-1': () => ({
    url: 'https://kottke.org/main/index.xml',
    title: 'Kottke',
    folders: ['Design'],
    addedAt: now(),
    updatedAt: now(),
    nextFetchAt: now(),
  }),
  'users/owner/settings/reader': () => ({
    folderOrder: ['Design'],
    images: true,
    updatedAt: now(),
  }),
  'users/owner/settings/assistant': () => ({ gardenOnArrival: true, updatedAt: now() }),
  'users/owner/habits/h1': () => ({
    name: 'Stretch',
    schedule: 'daily',
    time: '11:00',
    tz: 'America/Los_Angeles',
    answer: 'done',
    nudge: true,
    archived: false,
    createdAt: now(),
    updatedAt: now(),
    createdBy: 'user',
  }),
  'users/owner/habitLogs/h1_2026-11': () => ({
    habit: 'h1',
    month: '2026-11',
    days: { '21': { state: 'done', at: now() } },
    updatedAt: now(),
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

  it('accepts a project’s stages and item tags, and an item’s stage (2026-10-17)', async () => {
    const note = valid['users/owner/notes/n1'];
    const ref = owner().doc('users/owner/notes/n1');
    const project = () => ({ ...note(), conceptType: 'project' });
    await assertSucceeds(
      ref.set({ ...project(), stages: ['plan', 'thrown'], itemTags: ['gift'], stage: 'bisque' }),
    );
    await assertFails(ref.set({ ...project(), stages: 'plan' }));
    await assertFails(ref.set({ ...project(), itemTags: 'gift' }));
    await assertFails(ref.set({ ...project(), stage: 3 }));
  });

  it('accepts a project task’s stage and tags (2026-10-17)', async () => {
    const reminder = valid['users/owner/reminders/r1'];
    const ref = owner().doc('users/owner/reminders/r1');
    await assertSucceeds(ref.set({ ...reminder(), noteId: 'p', stage: 'draft', tags: ['urgent'] }));
    await assertFails(ref.set({ ...reminder(), stage: ['draft'] }));
    await assertSucceeds(ref.set({ ...reminder(), createdBy: 'claude', agent: 'Gemini CLI' }));
    await assertFails(ref.set({ ...reminder(), agent: false }));
    await assertFails(ref.set({ ...reminder(), tags: 'urgent' }));
  });

  it('accepts templates and notes made from them, with known modes only', async () => {
    const note = valid['users/owner/notes/n1'];
    const ref = owner().doc('users/owner/notes/n1');
    await assertSucceeds(ref.set({ ...note(), kind: 'template', templateMode: 'living' }));
    await assertSucceeds(ref.set({ ...note(), kind: 'template', templateMode: 'entry' }));
    await assertFails(ref.set({ ...note(), kind: 'template', templateMode: 'weekly' }));
    // Instructions for Claude are a template's own field (#111).
    await assertSucceeds(ref.set({ ...note(), kind: 'template', instructions: 'Group by aisle.' }));
    await assertFails(ref.set({ ...note(), kind: 'template', instructions: ['Group'] }));
    // The context note (#113).
    await assertSucceeds(ref.set({ ...note(), kind: 'context' }));
    // A recipe with its source and servings (#127).
    await assertSucceeds(
      ref.set({ ...note(), kind: 'recipe', source: { url: 'https://x.test/r' }, servings: 4 }),
    );
    await assertFails(ref.set({ ...note(), kind: 'recipe', servings: 'four' }));
    await assertFails(ref.set({ ...note(), kind: 'recipe', source: 'https://x.test/r' }));
    // An import the app asks for, and how it went (#128).
    await assertSucceeds(
      ref.set({ ...note(), kind: 'recipe', importState: 'requested', importError: 'x' }),
    );
    await assertFails(ref.set({ ...note(), kind: 'recipe', importState: 'please' }));
    await assertFails(ref.set({ ...note(), kind: 'recipe', importError: 404 }));
    // A meal plan and its week (#129).
    await assertSucceeds(ref.set({ ...note(), kind: 'mealplan', periodStart: '2026-10-19' }));
    await assertFails(ref.set({ ...note(), kind: 'mealplan', periodStart: 20261019 }));
    // What is on hand (#131).
    await assertSucceeds(ref.set({ ...note(), kind: 'pantry' }));
    await assertSucceeds(ref.set({ ...note(), fromTemplate: 't1' }));
    await assertFails(ref.set({ ...note(), fromTemplate: 1 }));
    await assertSucceeds(ref.set({ ...note(), baseHash: '5-1a2b3c4d' }));
    await assertFails(ref.set({ ...note(), baseHash: 5 }));
    // What a model title was made from, written by noteTitle beside it
    // (2026-11-22): the app's merged saves keep a note that carries it.
    await assertSucceeds(ref.set({ ...note(), titleSource: 'llm', titleHash: 'k1.0a1b' }));
    await assertSucceeds(ref.update({ body: 'more words', updatedAt: now() }));
    await assertFails(ref.set({ ...note(), titleHash: 7 }));
    // Which assistant wrote it (#142).
    await assertSucceeds(ref.set({ ...note(), updatedBy: 'claude', agent: 'Gemini CLI' }));
    await assertFails(ref.set({ ...note(), agent: 1 }));
    // Sent to an assistant (#143).
    await assertSucceeds(
      ref.set({
        ...note(),
        sendState: 'queued',
        sendAsk: 'File it',
        sentAt: now(),
      }),
    );
    await assertSucceeds(ref.set({ ...note(), sendState: 'done', sendOutcome: 'Filed.' }));
    await assertFails(ref.set({ ...note(), sendState: 'sent' }));
    await assertFails(ref.set({ ...note(), sendAsk: 3 }));
    await assertFails(ref.set({ ...note(), sentAt: 'today' }));
    await assertSucceeds(ref.set({ ...note(), sendState: 'queued', sendRun: 'run1' }));
    await assertFails(ref.set({ ...note(), sendRun: 7 }));
  });

  it('takes a clipping from the Reader (#163): kind clipping with its source', async () => {
    const note = valid['users/owner/notes/n1'];
    const ref = owner().doc('users/owner/notes/clip1');
    await assertSucceeds(
      ref.set({
        ...note(),
        kind: 'clipping',
        titleSource: 'user',
        source: { url: 'https://design.invalid/three-chairs', feedItemId: 'f-1-abc' },
      }),
    );
    await assertFails(ref.set({ ...note(), kind: 'article' }));
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

  it('lets the owner put a note in Trash and take it out, a Timestamp only (#217)', async () => {
    const note = valid['users/owner/notes/n1'];
    const ref = owner().doc('users/owner/notes/n1');
    await assertSucceeds(ref.set({ ...note(), deletedAt: now() }));
    await assertSucceeds(
      ref.set({ deletedAt: firebase.firestore.FieldValue.delete() }, { merge: true }),
    );
    await assertSucceeds(ref.set({ deletedAt: now() }, { merge: true }));
    await assertFails(ref.set({ deletedAt: 'yesterday' }, { merge: true }));
    await assertFails(ref.set({ ...note(), deletedAt: 1_800_000_000 }));
    for (const db of [intruder(), anonymous()]) {
      const theirs = db.doc('users/owner/notes/n1');
      await assertFails(theirs.set({ deletedAt: now() }, { merge: true }));
      await assertFails(
        theirs.set({ deletedAt: firebase.firestore.FieldValue.delete() }, { merge: true }),
      );
    }
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

  it('keeps provider keys server-only: secrets/ denied, settings/keys read-only (#144)', async () => {
    await seed('secrets/owner', { anthropic: { ciphertext: 'CiQA', updatedAt: now() } });
    await assertFails(owner().doc('secrets/owner').get());
    await assertFails(
      owner()
        .doc('secrets/owner')
        .set({ anthropic: { ciphertext: 'mine' } }),
    );
    await assertFails(owner().doc('secrets/owner').delete());
    await seed('users/owner/settings/keys', {
      anthropic: { masked: 'sk-ant-…0123', updatedAt: now() },
      updatedAt: now(),
    });
    await assertSucceeds(owner().doc('users/owner/settings/keys').get());
    await assertFails(intruder().doc('users/owner/settings/keys').get());
    await assertFails(
      owner()
        .doc('users/owner/settings/keys')
        .set({ anthropic: { masked: 'faked', updatedAt: now() }, updatedAt: now() }),
    );
    await assertFails(owner().doc('users/owner/settings/keys').delete());
  });

  it('keeps settings to one doc, app, holding a known theme and mode', async () => {
    const settings = valid['users/owner/settings/app'];
    await assertFails(owner().doc('users/owner/settings/other').set(settings()));
    const ref = owner().doc('users/owner/settings/app');
    await assertFails(ref.set({ ...settings(), theme: 'neon' }));
    await assertFails(ref.set({ ...settings(), mode: 'auto' }));
    // Start on (#219): one of the screens, Podcasts since #245, or absent.
    await assertSucceeds(ref.set({ ...settings(), startOn: 'home' }));
    await assertFails(ref.set({ ...settings(), startOn: 'garden' }));
    await assertSucceeds(ref.set({ ...settings(), startOn: 'podcasts' }));
    // Home's order and the tiles taken off it (#222): lists, or absent.
    await assertSucceeds(
      ref.set({ ...settings(), homeTiles: ['map', 'notes'], homeHidden: ['reader'] }),
    );
    await assertFails(ref.set({ ...settings(), homeTiles: 'map,notes' }));
    await assertFails(ref.set({ ...settings(), homeHidden: { map: true } }));
    await assertSucceeds(
      ref.set({ ...settings(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
    );
  });

  it('keeps the modules switched on in settings/modules, one map per module (#126)', async () => {
    const ref = owner().doc('users/owner/settings/modules');
    const modules = valid['users/owner/settings/modules'];
    await assertSucceeds(
      ref.set({ projects: { enabled: false, config: { a: 1 } }, updatedAt: now() }),
    );
    await assertFails(ref.set({ ...modules(), projects: true }));
    // Kitchen (#127); a module the app does not know is refused.
    await assertSucceeds(ref.set({ ...modules(), kitchen: { enabled: true } }));
    // Podcasts (#245), a map like the rest.
    await assertSucceeds(ref.set({ ...modules(), podcasts: { enabled: false } }));
    await assertFails(ref.set({ ...modules(), podcasts: true }));
    // Habits (#324), a map like the rest.
    await assertSucceeds(ref.set({ ...modules(), habits: { enabled: true } }));
    await assertSucceeds(
      ref.set({ ...modules(), habits: { enabled: false, config: { weekStart: 'Sun' } } }),
    );
    // The device's zone (Eric, 2026-11-22) is one more key of the
    // module's config, a map the rules take whole: the app's merge write
    // of it is allowed, and another gardener's is not.
    await assertSucceeds(
      ref.set(
        { habits: { enabled: true, config: { weekStart: 'Mon', tz: 'Europe/Paris' } } },
        { merge: true },
      ),
    );
    await assertFails(
      intruder()
        .doc('users/owner/settings/modules')
        .set({ habits: { enabled: true, config: { tz: 'Europe/Paris' } } }, { merge: true }),
    );
    await assertFails(ref.set({ ...modules(), habits: true }));
    await assertFails(ref.set({ ...modules(), garden: { enabled: true } }));
    // Each doc keeps its own shape.
    await assertFails(ref.set(valid['users/owner/settings/app']()));
    await assertFails(owner().doc('users/owner/settings/app').set(modules()));
  });

  it('keeps the assistant’s switches in settings/assistant (#214)', async () => {
    const ref = owner().doc('users/owner/settings/assistant');
    const assistant = valid['users/owner/settings/assistant'];
    await assertSucceeds(ref.set({ updatedAt: now() }));
    await assertSucceeds(ref.set({ gardenOnArrival: false, updatedAt: now() }));
    await assertFails(ref.set({ ...assistant(), gardenOnArrival: 'yes' }));
    await assertFails(ref.set(valid['users/owner/settings/app']()));
    await assertFails(owner().doc('users/owner/settings/app').set(assistant()));
  });

  it('lets a note say it was sent on arrival, as a boolean (#214)', async () => {
    const note = valid['users/owner/notes/n1'];
    const ref = owner().doc('users/owner/notes/n1');
    await assertSucceeds(ref.set({ ...note(), sendState: 'queued', sentOnArrival: true }));
    await assertFails(ref.set({ ...note(), sentOnArrival: 'yes' }));
  });

  it('lets the owner hold a note back and let it go, as a boolean (#229)', async () => {
    const note = valid['users/owner/notes/n1'];
    const ref = owner().doc('users/owner/notes/n1');
    await assertSucceeds(ref.set(note()));
    await assertSucceeds(ref.update({ gardenHold: true }));
    await assertSucceeds(ref.update({ gardenHold: false }));
    await assertFails(ref.update({ gardenHold: 'yes' }));
    await assertFails(intruder().doc('users/owner/notes/n1').update({ gardenHold: true }));
  });

  it('keeps what is never gardened on arrival in settings/assistant (#229)', async () => {
    const ref = owner().doc('users/owner/settings/assistant');
    const assistant = valid['users/owner/settings/assistant'];
    await assertSucceeds(
      ref.set({ ...assistant(), arrivalSkip: { templates: ['t1'], tags: ['private'] } }),
    );
    await assertSucceeds(ref.set({ ...assistant(), arrivalSkip: { templates: [], tags: [] } }));
    await assertFails(ref.set({ ...assistant(), arrivalSkip: 'private' }));
    await assertFails(ref.set({ ...assistant(), arrivalSkip: ['private'] }));
    await assertFails(
      intruder()
        .doc('users/owner/settings/assistant')
        .set({ ...assistant(), arrivalSkip: { templates: [], tags: [] } }),
    );
  });

  it('keeps the daily digest switch in settings/assistant, a map only, the owner’s (#237)', async () => {
    const ref = owner().doc('users/owner/settings/assistant');
    const assistant = valid['users/owner/settings/assistant'];
    const digest = { push: true, hour: 8, timeZone: 'America/New_York' };
    await assertSucceeds(ref.set({ ...assistant(), digest }));
    // A merge write beside the other switches, as the app makes it.
    await assertSucceeds(
      ref.set({ digest: { push: false, hour: 21 }, updatedAt: now() }, { merge: true }),
    );
    await assertSucceeds(
      ref.set(
        { digest: firebase.firestore.FieldValue.delete(), updatedAt: now() },
        { merge: true },
      ),
    );
    await assertFails(ref.set({ ...assistant(), digest: true }));
    await assertFails(ref.set({ ...assistant(), digest: 8 }));
    await assertFails(ref.set({ ...assistant(), digest: ['push'] }));
    await assertFails(ref.set({ ...assistant(), digestSentFor: '2026-11-09' }));
    await assertFails(
      intruder()
        .doc('users/owner/settings/assistant')
        .set({ ...assistant(), digest }),
    );
    await seed('users/owner/settings/assistant', { ...assistant(), digest });
    await assertFails(intruder().doc('users/owner/settings/assistant').get());
    await assertFails(owner().doc('users/owner/usage/digest').set({ sentFor: '2026-11-09' }));
  });

  it('keeps the habit nudges’ sent marks server-only (#324 step 4)', async () => {
    await seed('users/owner/usage/habitNudges', { sent: { floss: '2026-11-21' } });
    await assertFails(owner().doc('users/owner/usage/habitNudges').get());
    await assertFails(
      owner()
        .doc('users/owner/usage/habitNudges')
        .set({ sent: { floss: '2026-11-20' } }),
    );
    await assertFails(owner().doc('users/owner/usage/habitNudges').delete());
  });

  it('keeps the switch that seals note text in settings/assistant, a bool only, the owner’s (2026-11-15)', async () => {
    const ref = owner().doc('users/owner/settings/assistant');
    const assistant = valid['users/owner/settings/assistant'];
    await assertSucceeds(ref.set({ ...assistant(), sealNotes: true }));
    // A merge write beside the other switches, as the app makes it, on and off.
    await assertSucceeds(ref.set({ sealNotes: false, updatedAt: now() }, { merge: true }));
    await assertSucceeds(ref.set({ sealNotes: true, updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ ...assistant(), sealNotes: 'on' }));
    await assertFails(ref.set({ ...assistant(), sealNotes: 1 }));
    await assertFails(ref.set({ ...assistant(), sealNotes: { on: true } }));
    await assertFails(ref.set({ ...assistant(), sealNote: true }));
    // Never in the theme's doc, and never another gardener's to set or read.
    await assertFails(
      owner()
        .doc('users/owner/settings/app')
        .set({ theme: 'moss', mode: 'system', sealNotes: true, updatedAt: now() }),
    );
    await assertFails(
      intruder()
        .doc('users/owner/settings/assistant')
        .set({ ...assistant(), sealNotes: true }),
    );
    await seed('users/owner/settings/assistant', { ...assistant(), sealNotes: true });
    await assertFails(intruder().doc('users/owner/settings/assistant').get());
  });

  it('lets the owner set and clear how a note takes new material, a known mode only (#231)', async () => {
    const note = valid['users/owner/notes/n1'];
    const ref = owner().doc('users/owner/notes/n1');
    await assertSucceeds(ref.set({ ...note(), mode: 'log', instructions: 'Dated.' }));
    await assertSucceeds(ref.set({ mode: 'synthesis' }, { merge: true }));
    await assertSucceeds(
      ref.set({ mode: firebase.firestore.FieldValue.delete() }, { merge: true }),
    );
    await assertFails(ref.set({ mode: 'diary' }, { merge: true }));
    await assertFails(ref.set({ ...note(), mode: ['list'] }));
    for (const db of [intruder(), anonymous()]) {
      await assertFails(db.doc('users/owner/notes/n1').set({ mode: 'list' }, { merge: true }));
    }
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

describe('the Reader (#159): feeds are the gardener’s, articles the fetcher’s', () => {
  const feed = valid['users/owner/feeds/f-1'];
  const item = () => ({
    feedId: 'f-1',
    title: 'A post',
    link: 'https://kottke.org/a-post',
    published: now(),
    summary: 'First lines',
    content: 'First lines and the rest',
    read: false,
    saved: false,
    createdAt: now(),
    updatedAt: now(),
  });

  it('checks a feed’s shape, and lets the fetcher’s fields through', async () => {
    const ref = owner().doc('users/owner/feeds/f-1');
    await assertFails(ref.set({ ...feed(), folders: 'Design' }));
    await assertFails(ref.set({ ...feed(), url: 7 }));
    await assertSucceeds(
      ref.set({ ...feed(), etag: 'W/"1"', fetchedAt: now(), interval: 60, errorCount: 0 }),
    );
    await assertSucceeds(ref.set({ folders: ['Games'], updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ ...feed(), guessed: true }));
    // A podcast (#178): no other kind is one.
    await assertSucceeds(ref.set({ ...feed(), kind: 'podcast' }));
    await assertFails(ref.set({ ...feed(), kind: 'video' }));
    await assertFails(ref.set({ ...feed(), kind: true }));
  });

  it('lets the owner move a feed between the Reader and Podcasts, and set its queue switch (#245)', async () => {
    const path = 'users/owner/feeds/f-1';
    const ref = owner().doc(path);
    await assertSucceeds(ref.set(feed()));
    // Move to Podcasts, and back to the Reader: kind set, then cleared.
    await assertSucceeds(ref.set({ kind: 'podcast', updatedAt: now() }, { merge: true }));
    await assertSucceeds(
      ref.set({ kind: firebase.firestore.FieldValue.delete(), updatedAt: now() }, { merge: true }),
    );
    // Add a podcast writes both, the switch off by default or on.
    await assertSucceeds(ref.set({ ...feed(), kind: 'podcast', autoQueue: false }));
    await assertSucceeds(ref.set({ autoQueue: true, updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ ...feed(), kind: 'podcast', autoQueue: 'yes' }));
    await assertFails(ref.set({ autoQueue: 1, updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ kind: 'reader', updatedAt: now() }, { merge: true }));
    // Nobody else moves it or reads it.
    await assertFails(
      intruder().doc(path).set({ kind: 'podcast', updatedAt: now() }, { merge: true }),
    );
    await assertFails(intruder().doc(path).get());
    await assertFails(
      anonymous().doc(path).set({ autoQueue: true, updatedAt: now() }, { merge: true }),
    );
  });

  it('lets a feed carry its artwork, a web link only (#246)', async () => {
    const path = 'users/owner/feeds/f-1';
    const ref = owner().doc(path);
    await assertSucceeds(ref.set({ ...feed(), image: 'https://kiln.example/show.jpg' }));
    await assertSucceeds(ref.set({ ...feed(), image: 'HTTP://kiln.example/show.png' }));
    // The fetcher's image rides along when the app moves the feed.
    await seed(path, { ...feed(), kind: 'podcast', image: 'https://kiln.example/show.jpg' });
    await assertSucceeds(ref.set({ folders: ['Making'], updatedAt: now() }, { merge: true }));
    // Not a link, or not a web one: refused.
    await assertFails(ref.set({ ...feed(), image: 7 }));
    await assertFails(ref.set({ ...feed(), image: 'show.jpg' }));
    await assertFails(ref.set({ ...feed(), image: 'javascript:alert(1)' }));
    await assertFails(ref.set({ ...feed(), image: 'data:image/png;base64,AAAA' }));
    await assertFails(
      ref.set({ image: 'ftp://kiln.example/a.jpg', updatedAt: now() }, { merge: true }),
    );
    await assertFails(intruder().doc(path).get());
  });

  it('lets the owner mark an article read or saved, and nothing else', async () => {
    const path = 'users/owner/feedItems/f-1-abc';
    const ref = owner().doc(path);
    await assertFails(ref.set(item()));
    await seed(path, item());
    await assertSucceeds(ref.get());
    await assertSucceeds(ref.set({ read: true, readAt: now(), updatedAt: now() }, { merge: true }));
    await assertSucceeds(ref.set({ saved: true, updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ read: 'yes', updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ read: true }, { merge: true }));
    // Saved for later or filed in the garden (#163): the app ties the record on.
    await assertSucceeds(
      ref.set({ attachmentId: 'a1', saved: true, updatedAt: now() }, { merge: true }),
    );
    await assertSucceeds(ref.set({ noteId: 'n9', updatedAt: now() }, { merge: true }));
    // expireAt (#171): the fetcher's; the owner clears it on save, never sets it.
    await assertFails(ref.set({ expireAt: now(), updatedAt: now() }, { merge: true }));
    await seed(path, { ...item(), expireAt: now() });
    await assertSucceeds(
      ref.set(
        { saved: true, expireAt: firebase.firestore.FieldValue.delete(), updatedAt: now() },
        { merge: true },
      ),
    );
    await assertFails(ref.set({ noteId: 9, updatedAt: now() }, { merge: true }));
    // An episode's audio (#178) is the fetcher's: the owner neither adds nor changes it.
    const enclosure = { url: 'https://cdn.invalid/one.mp3', type: 'audio/mpeg', seconds: 60 };
    await assertFails(ref.set({ enclosure, updatedAt: now() }, { merge: true }));
    await assertFails(
      ref.set({ image: 'https://cdn.invalid/art.jpg', updatedAt: now() }, { merge: true }),
    );
    await assertFails(ref.set({ episode: 3, updatedAt: now() }, { merge: true }));
    // Tags (#176) are the server's, from a Feedly board: the owner neither adds nor changes them.
    await assertFails(ref.set({ tags: ['Pottery'], updatedAt: now() }, { merge: true }));
    await seed(path, { ...item(), enclosure, tags: ['Pottery'] });
    await assertSucceeds(ref.set({ read: true, updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ tags: ['Pottery', 'Mine'], updatedAt: now() }, { merge: true }));
    await assertFails(
      ref.set({ enclosure: { ...enclosure, seconds: 1 }, updatedAt: now() }, { merge: true }),
    );
    await assertFails(ref.set({ title: 'Mine now', updatedAt: now() }, { merge: true }));
    // The word index (#175) is the fetcher's: the owner neither adds nor changes it.
    await assertFails(ref.set({ terms: ['chair'], updatedAt: now() }, { merge: true }));
    // So is the server's note that every article is indexed (review on #197).
    await assertFails(
      owner().doc('users/owner/usage/reader').set({ indexedAt: now() }, { merge: true }),
    );
    await seed(path, { ...item(), terms: ['chair'] });
    await assertSucceeds(ref.set({ read: true, updatedAt: now() }, { merge: true }));
    await assertFails(
      ref.set({ terms: ['chair', 'mine'], read: true, updatedAt: now() }, { merge: true }),
    );
    await assertFails(
      ref.set({ content: 'rewritten', read: true, updatedAt: now() }, { merge: true }),
    );
    await assertFails(ref.delete());
    await assertFails(intruder().doc(path).get());
    await assertFails(intruder().doc(path).set({ read: true, updatedAt: now() }, { merge: true }));
  });

  it('lets the owner keep where an episode was left, and nothing of its audio (#179)', async () => {
    const path = 'users/owner/feedItems/f-1-pod';
    const ref = owner().doc(path);
    const enclosure = { url: 'https://cdn.invalid/one.mp3', type: 'audio/mpeg', seconds: 60 };
    await seed(path, { ...item(), enclosure });
    await assertSucceeds(
      ref.set({ position: 754.5, playedAt: now(), updatedAt: now() }, { merge: true }),
    );
    // Heard to the end: played and read in one write.
    await assertSucceeds(
      ref.set(
        {
          position: 60,
          played: true,
          read: true,
          readAt: now(),
          playedAt: now(),
          updatedAt: now(),
        },
        { merge: true },
      ),
    );
    await assertFails(ref.set({ position: '12:34', updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ position: -1, updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ playedAt: 'today', updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ played: 'yes', updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ position: 10, playedAt: now() }, { merge: true }));
    await assertFails(
      ref.set(
        { position: 10, enclosure: { ...enclosure, seconds: 10 }, updatedAt: now() },
        { merge: true },
      ),
    );
    await assertFails(
      intruder()
        .doc(path)
        .set({ position: 10, playedAt: now(), updatedAt: now() }, { merge: true }),
    );
  });

  it('refuses a listening place more than a minute behind the stored one or ahead of the server (#190)', async () => {
    const path = 'users/owner/feedItems/f-1-pod';
    const ref = owner().doc(path);
    const at = (ms: number) => firebase.firestore.Timestamp.fromMillis(ms);
    const t = Date.parse('2026-11-07T12:00:00Z');
    await seed(path, item());
    // The first playedAt on an item without one.
    await assertSucceeds(
      ref.set({ position: 100, playedAt: at(t), updatedAt: now() }, { merge: true }),
    );
    // The same time again, and a newer one.
    await assertSucceeds(
      ref.set({ position: 101, playedAt: at(t), updatedAt: now() }, { merge: true }),
    );
    await assertSucceeds(
      ref.set({ position: 200, playedAt: at(t + 180_000), updatedAt: now() }, { merge: true }),
    );
    // Thirty seconds behind passes, for clock skew between devices.
    await assertSucceeds(
      ref.set({ position: 190, playedAt: at(t + 150_000), updatedAt: now() }, { merge: true }),
    );
    // A place kept offline two minutes earlier and synced late is refused.
    await assertFails(
      ref.set({ position: 150, playedAt: at(t + 30_000), updatedAt: now() }, { merge: true }),
    );
    // Thirty seconds ahead of the server passes; ten minutes ahead, a
    // device's clock running far ahead, is refused.
    const ahead = (ms: number) => firebase.firestore.Timestamp.fromMillis(Date.now() + ms);
    await assertSucceeds(
      ref.set({ position: 210, playedAt: ahead(30_000), updatedAt: now() }, { merge: true }),
    );
    await assertFails(
      ref.set({ position: 220, playedAt: ahead(600_000), updatedAt: now() }, { merge: true }),
    );
    // The end-of-episode marks go without playedAt, so they pass onto an
    // item holding a newer place; so do other marks.
    await assertSucceeds(
      ref.set({ played: true, read: true, readAt: now(), updatedAt: now() }, { merge: true }),
    );
    await assertSucceeds(ref.set({ saved: true, updatedAt: now() }, { merge: true }));
  });

  it('still takes other marks on an item already stamped ahead of the server (#190)', async () => {
    const path = 'users/owner/feedItems/f-1-pod';
    const ref = owner().doc(path);
    const ahead = (ms: number) => firebase.firestore.Timestamp.fromMillis(Date.now() + ms);
    // Written by a fast clock before the ahead check was deployed.
    await seed(path, { ...item(), position: 300, playedAt: ahead(600_000) });
    await assertSucceeds(ref.set({ saved: true, updatedAt: now() }, { merge: true }));
    await assertSucceeds(
      ref.set({ played: true, read: true, readAt: now(), updatedAt: now() }, { merge: true }),
    );
    // A write that sets playedAt ten minutes ahead is still refused.
    await assertFails(
      ref.set({ position: 310, playedAt: ahead(660_000), updatedAt: now() }, { merge: true }),
    );
  });

  it('lets the owner set, change and clear an episode’s place in the queue (#249)', async () => {
    const path = 'users/owner/feedItems/f-1-pod';
    const ref = owner().doc(path);
    const t = Date.parse('2026-11-10T12:00:00Z');
    await seed(path, item());
    await assertSucceeds(ref.set({ queue: t, updatedAt: now() }, { merge: true }));
    // Play next and a drop between two: below the first, a midpoint.
    await assertSucceeds(ref.set({ queue: t - 1000.5, updatedAt: now() }, { merge: true }));
    await assertSucceeds(ref.set({ queue: -3, updatedAt: now() }, { merge: true }));
    // Off the queue, with heard in the same write.
    await assertSucceeds(
      ref.set(
        { queue: firebase.firestore.FieldValue.delete(), played: true, updatedAt: now() },
        { merge: true },
      ),
    );
    await assertFails(ref.set({ queue: '1', updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ queue: true, updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ queue: Infinity, updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ queue: 1e16, updatedAt: now() }, { merge: true }));
    await assertFails(ref.set({ queue: t }, { merge: true }));
    await assertFails(intruder().doc(path).set({ queue: t, updatedAt: now() }, { merge: true }));
    await assertFails(anonymous().doc(path).set({ queue: t, updatedAt: now() }, { merge: true }));
  });

  it('lets a place in the queue clear the keep-for expiry in the same write, never set one (review on #252)', async () => {
    const path = 'users/owner/feedItems/f-1-kept';
    const ref = owner().doc(path);
    const t = Date.parse('2026-11-10T12:00:00Z');
    await seed(path, { ...item(), expireAt: now() });
    await assertSucceeds(
      ref.set(
        { queue: t, expireAt: firebase.firestore.FieldValue.delete(), updatedAt: now() },
        { merge: true },
      ),
    );
    // Clearing one that is not there, as a renumber does, is no change to it.
    await assertSucceeds(
      ref.set(
        { queue: t + 1000, expireAt: firebase.firestore.FieldValue.delete(), updatedAt: now() },
        { merge: true },
      ),
    );
    await assertFails(ref.set({ queue: t, expireAt: now(), updatedAt: now() }, { merge: true }));
  });

  it('keeps which module owns an item the server’s: the owner cannot set, change or clear it (#248)', async () => {
    const path = 'users/owner/feedItems/f-1-stamp';
    const ref = owner().doc(path);
    await seed(path, { ...item(), podcast: true });
    await assertFails(ref.set({ podcast: false, updatedAt: now() }, { merge: true }));
    await assertFails(
      ref.set(
        { podcast: firebase.firestore.FieldValue.delete(), updatedAt: now() },
        { merge: true },
      ),
    );
    // Not even beside a mark the owner may make.
    await assertFails(ref.set({ read: true, podcast: false, updatedAt: now() }, { merge: true }));
    await assertSucceeds(ref.set({ read: true, updatedAt: now() }, { merge: true }));
    // An item stored before the stamp cannot be given one from the app.
    const bare = 'users/owner/feedItems/f-1-bare';
    await seed(bare, item());
    await assertFails(owner().doc(bare).set({ podcast: false, updatedAt: now() }, { merge: true }));
  });

  it('keeps the server’s note on the Reader (#248) read-only: settings/readerServer', async () => {
    const path = 'users/owner/settings/readerServer';
    await seed(path, { podcastStampedAt: now() });
    await assertSucceeds(owner().doc(path).get());
    await assertFails(intruder().doc(path).get());
    await assertFails(owner().doc(path).set({ podcastStampedAt: now() }));
    await assertFails(owner().doc(path).set({ podcastStampedAt: now() }, { merge: true }));
    await assertFails(owner().doc(path).delete());
  });

  it('keeps the Reader’s settings to their shape', async () => {
    const ref = owner().doc('users/owner/settings/reader');
    await assertFails(ref.set({ folderOrder: 'Design', images: true, updatedAt: now() }));
    // Keep-for months (#171), read on scroll (#172), seen times (#173).
    await assertSucceeds(
      ref.set({
        folderOrder: [],
        images: true,
        keepMonths: 3,
        readOnScroll: true,
        seenAt: { Design: now() },
        updatedAt: now(),
      }),
    );
    await assertFails(
      ref.set({ folderOrder: [], images: true, keepMonths: '3', updatedAt: now() }),
    );
    await assertFails(ref.set(valid['users/owner/settings/app']()));
  });
});

describe('habits (#324): the gardener’s habits and their month logs', () => {
  const habit = valid['users/owner/habits/h1'];
  const habitLog = valid['users/owner/habitLogs/h1_2026-11'];

  it('takes each schedule and answer kind, with what each needs', async () => {
    const ref = owner().doc('users/owner/habits/h1');
    await assertSucceeds(ref.set({ ...habit(), schedule: 'weekly' }));
    await assertSucceeds(ref.set({ ...habit(), schedule: 'monthly' }));
    await assertSucceeds(ref.set({ ...habit(), answer: 'text' }));
    await assertSucceeds(ref.set({ ...habit(), answer: 'choice', choices: ['calm', 'tense'] }));
    await assertSucceeds(ref.set({ ...habit(), answer: 'note', template: 'feelings' }));
    const { time: _time, ...untimed } = habit() as Record<string, unknown>;
    await assertSucceeds(ref.set({ ...untimed, nudge: false }));
    await assertSucceeds(ref.set({ ...habit(), archived: true }));
    await assertSucceeds(ref.set({ ...habit(), createdBy: 'claude', agent: 'Claude' }));
    // A derived id, as the feelings journal's may be (step 7).
    await assertSucceeds(owner().doc('users/owner/habits/feelings-lunch').set(habit()));
  });

  it('refuses a habit out of shape or out of bounds', async () => {
    const ref = owner().doc('users/owner/habits/h1');
    await assertFails(ref.set({ ...habit(), schedule: 'fortnightly' }));
    await assertFails(ref.set({ ...habit(), answer: 'number' }));
    await assertFails(ref.set({ ...habit(), nudge: 'yes' }));
    await assertFails(ref.set({ ...habit(), archived: 0 }));
    await assertFails(ref.set({ ...habit(), choices: 'calm' }));
    await assertFails(ref.set({ ...habit(), name: '' }));
    await assertSucceeds(ref.set({ ...habit(), name: 'x'.repeat(80) }));
    await assertFails(ref.set({ ...habit(), name: 'x'.repeat(81) }));
    await assertFails(ref.set({ ...habit(), tz: '' }));
    await assertFails(ref.set({ ...habit(), tz: 'x'.repeat(65) }));
    await assertFails(ref.set({ ...habit(), time: '24:00' }));
    await assertFails(ref.set({ ...habit(), time: '9:00' }));
    await assertFails(ref.set({ ...habit(), time: '11:00 am' }));
    // A nudge needs a time.
    const { time: _time, ...untimed } = habit() as Record<string, unknown>;
    await assertFails(ref.set(untimed));
    // Choices with, and only with, a choice answer: two to twelve.
    await assertFails(ref.set({ ...habit(), answer: 'choice' }));
    await assertFails(ref.set({ ...habit(), choices: ['calm', 'tense'] }));
    await assertFails(ref.set({ ...habit(), answer: 'choice', choices: ['calm'] }));
    const twelve = Array.from({ length: 12 }, (_, i) => `mood ${i}`);
    await assertSucceeds(ref.set({ ...habit(), answer: 'choice', choices: twelve }));
    await assertFails(ref.set({ ...habit(), answer: 'choice', choices: [...twelve, 'more'] }));
    // A template with, and only with, a note answer.
    await assertFails(ref.set({ ...habit(), answer: 'note' }));
    await assertFails(ref.set({ ...habit(), template: 'feelings' }));
    // An id with an underscore would not join a month unambiguously.
    await assertFails(owner().doc('users/owner/habits/h_1').set(habit()));
  });

  it('takes a weekly habit’s target, 2 to 7 whole days, on weekly only (2026-11-23)', async () => {
    const ref = owner().doc('users/owner/habits/h1');
    await assertSucceeds(ref.set({ ...habit(), schedule: 'weekly', times: 2 }));
    await assertSucceeds(ref.set({ ...habit(), schedule: 'weekly', times: 7 }));
    // Made daily, the target goes in the same write, or it is refused.
    await assertFails(ref.set({ schedule: 'daily' }, { merge: true }));
    await assertSucceeds(ref.set({ schedule: 'weekly', times: 3 }, { merge: true }));
    await assertFails(ref.set({ ...habit(), schedule: 'daily', times: 2 }));
    await assertFails(ref.set({ ...habit(), schedule: 'monthly', times: 2 }));
    await assertFails(ref.set({ ...habit(), schedule: 'weekly', times: 1 }));
    await assertFails(ref.set({ ...habit(), schedule: 'weekly', times: 8 }));
    await assertFails(ref.set({ ...habit(), schedule: 'weekly', times: 2.5 }));
    await assertFails(ref.set({ ...habit(), schedule: 'weekly', times: '2' }));
  });

  it('takes a weekly habit’s day, on weekly only and never with a target (2026-11-25)', async () => {
    const ref = owner().doc('users/owner/habits/h1');
    await assertSucceeds(ref.set({ ...habit(), schedule: 'weekly', weekday: 'Wed' }));
    await assertSucceeds(ref.set({ ...habit(), schedule: 'weekly', weekday: 'Sun' }));
    // Made daily, the day goes in the same write, or it is refused.
    await assertFails(ref.set({ schedule: 'daily' }, { merge: true }));
    await assertFails(ref.set({ schedule: 'monthly' }, { merge: true }));
    await assertSucceeds(
      ref.set(
        { schedule: 'daily', weekday: firebase.firestore.FieldValue.delete() },
        { merge: true },
      ),
    );
    await assertFails(ref.set({ ...habit(), schedule: 'daily', weekday: 'Wed' }));
    await assertFails(ref.set({ ...habit(), schedule: 'monthly', weekday: 'Wed' }));
    await assertFails(ref.set({ ...habit(), schedule: 'weekly', weekday: 'Wed', times: 2 }));
    await assertFails(ref.set({ ...habit(), schedule: 'weekly', weekday: 'Wednesday' }));
    await assertFails(ref.set({ ...habit(), schedule: 'weekly', weekday: 3 }));
  });

  it('merges a day into a month’s log, as two devices ticking offline do', async () => {
    const ref = owner().doc('users/owner/habitLogs/h1_2026-11');
    await assertSucceeds(ref.set(habitLog()));
    await assertSucceeds(
      ref.set(
        { days: { '20': { state: 'skipped', at: now() } }, updatedAt: now() },
        { merge: true },
      ),
    );
    await assertSucceeds(ref.update({ 'days.19': { state: 'done', at: now() }, updatedAt: now() }));
    const days = (await ref.get()).data()?.['days'] as Record<string, unknown>;
    if (Object.keys(days).sort().join() !== '19,20,21') throw new Error('days did not merge');
    await assertSucceeds(ref.update({ 'days.21': firebase.firestore.FieldValue.delete() }));
  });

  it('keeps a log at the id its habit and month derive, at most 31 days', async () => {
    const ref = owner().doc('users/owner/habitLogs/h1_2026-11');
    await assertFails(owner().doc('users/owner/habitLogs/h2_2026-11').set(habitLog()));
    await assertFails(owner().doc('users/owner/habitLogs/h1-2026-11').set(habitLog()));
    await assertFails(owner().doc('users/owner/habitLogs/h1_2026-12').set(habitLog()));
    await assertFails(ref.set({ ...habitLog(), month: '2026-13' }));
    await assertFails(
      owner()
        .doc('users/owner/habitLogs/h1_2026-1')
        .set({ ...habitLog(), month: '2026-1' }),
    );
    await assertFails(ref.set({ ...habitLog(), month: 202611 }));
    await assertFails(ref.set({ ...habitLog(), days: [] }));
    await assertFails(ref.set({ ...habitLog(), days: { '32': { state: 'done', at: now() } } }));
    await assertFails(ref.set({ ...habitLog(), days: { '1': { state: 'done', at: now() } } }));
    await assertFails(ref.set({ ...habitLog(), days: { '2026-11-21': { state: 'done' } } }));
    const all = Object.fromEntries(
      Array.from({ length: 31 }, (_, i) => [
        String(i + 1).padStart(2, '0'),
        { state: 'done', at: now() },
      ]),
    );
    await assertFails(
      ref.set({ ...habitLog(), days: { ...all, '00': { state: 'done', at: now() } } }),
    );
    const { days: _days, ...dayless } = habitLog() as Record<string, unknown>;
    await assertFails(ref.set(dayless));
  });

  // Review of #327 (2026-11-21): the bounds the schema keeps that the
  // first rules missed, and each day's entry.
  it('refuses an empty template, a bad choice, a repeated one and a bad agent', async () => {
    const ref = owner().doc('users/owner/habits/h1');
    await assertFails(ref.set({ ...habit(), answer: 'note', template: '' }));
    const choice = (choices: unknown[]) => ref.set({ ...habit(), answer: 'choice', choices });
    await assertSucceeds(choice(['x'.repeat(40), 'calm']));
    await assertFails(choice(['x'.repeat(41), 'calm']));
    await assertFails(choice(['calm', '']));
    await assertFails(choice(['calm', 3]));
    await assertFails(choice(['calm', { mood: 'calm' }]));
    await assertFails(choice(['calm', 'tense', 'calm']));
    const eleven = Array.from({ length: 11 }, (_, i) => `mood ${i}`);
    await assertFails(choice([...eleven, 'x'.repeat(41)]));
    await assertFails(choice([...eleven, '']));
    await assertFails(ref.set({ ...habit(), createdBy: 'claude', agent: '' }));
    await assertSucceeds(ref.set({ ...habit(), createdBy: 'claude', agent: 'a'.repeat(100) }));
    await assertFails(ref.set({ ...habit(), createdBy: 'claude', agent: 'a'.repeat(101) }));
  });

  /** A sealed-looking answer of exactly `size` characters. */
  const sealed = (size: number) => '\uE000mg1.' + 'A'.repeat(size - 5);

  it('checks each day’s entry against HabitEntry', async () => {
    const ref = owner().doc('users/owner/habitLogs/h1_2026-11');
    const day = (entry: unknown) => ref.set({ ...habitLog(), days: { '21': entry } });
    await assertSucceeds(day({ state: 'skipped', at: now() }));
    await assertSucceeds(day({ state: 'done', at: now(), answer: sealed(4000) }));
    await assertSucceeds(day({ state: 'done', at: now(), noteId: 'n1' }));
    // Not a map.
    await assertFails(day('done'));
    await assertFails(day(true));
    await assertFails(day(['done']));
    // An unknown key, or nested data under the day.
    await assertFails(day({ state: 'done', at: now(), mood: 'calm' }));
    await assertFails(day({ state: 'done', at: now(), extra: { deep: { deeper: 'x' } } }));
    await assertFails(day({ state: { done: true }, at: now() }));
    await assertFails(day({ state: 'done', at: now(), answer: { text: 'calm' } }));
    // A missing or mistyped field.
    await assertFails(day({ state: 'done' }));
    await assertFails(day({ state: 'done', at: '2026-11-21T11:00:00Z' }));
    // A bad state.
    await assertFails(day({ state: 'missed', at: now() }));
    // A skip holds no answer and no note.
    await assertFails(day({ state: 'skipped', at: now(), answer: sealed(100) }));
    await assertFails(day({ state: 'skipped', at: now(), noteId: 'n1' }));
    // An answer or a note, not both.
    await assertFails(day({ state: 'done', at: now(), answer: sealed(100), noteId: 'n1' }));
    // An answer over the stored bound; a note id empty or not a string.
    await assertFails(day({ state: 'done', at: now(), answer: sealed(4001) }));
    await assertFails(day({ state: 'done', at: now(), noteId: '' }));
    await assertFails(day({ state: 'done', at: now(), noteId: 7 }));
    // One bad day among good ones, written by a merge as a tick is.
    await assertSucceeds(ref.set(habitLog()));
    await assertFails(ref.update({ 'days.20': { state: 'done', at: now(), x: 1 } }));
    await assertFails(ref.update({ 'days.21.answer': 'x'.repeat(4001) }));
  });

  it('refuses a day the month lacks', async () => {
    const log = (month: string, day: string) =>
      owner()
        .doc(`users/owner/habitLogs/h1_${month}`)
        .set({ ...habitLog(), month, days: { [day]: { state: 'done', at: now() } } });
    await assertSucceeds(log('2026-12', '31'));
    await assertFails(log('2026-11', '31'));
    await assertSucceeds(log('2026-11', '30'));
    await assertFails(log('2026-02', '30'));
    await assertFails(log('2026-02', '29'));
    await assertSucceeds(log('2026-02', '28'));
    await assertSucceeds(log('2028-02', '29'));
    await assertSucceeds(log('2000-02', '29'));
    await assertFails(log('2100-02', '29'));
  });

  // An answer held on the device for the note key (step 6, 2026-11-22)
  // is written later, merged into its tick's entry alone: the entry it
  // makes is checked whole, so the same shape as a tick with an answer.
  it('takes an answer merged into a tick’s entry alone, never onto an empty day', async () => {
    const ref = owner().doc('users/owner/habitLogs/h1_2026-11');
    await assertSucceeds(ref.set(habitLog()));
    const answer = (day: string, over: Record<string, unknown> = {}) =>
      ref.set(
        {
          habit: 'h1',
          month: '2026-11',
          days: { [day]: { answer: sealed(300), ...over } },
          updatedAt: now(),
        },
        { merge: true },
      );
    await assertSucceeds(answer('21'));
    await assertFails(answer('22'));
    await assertFails(answer('21', { noteId: 'n1' }));
  });

  // a request may evaluate, so a write checks only the entries it adds
  // or changes, at most four. A full month is the log nearest the
  // limits: every tick on it carries all 31 entries.
  it('takes a full month of 31 entries, answers at the bound, four days a write', async () => {
    const ref = owner().doc('users/owner/habitLogs/h1_2026-12');
    const key = (i: number) => String(i + 1).padStart(2, '0');
    const entry = (i: number) =>
      i % 4 === 0
        ? { state: 'done', at: now(), answer: sealed(4000) }
        : i % 4 === 1
          ? { state: 'done', at: now(), noteId: `n${i}` }
          : i % 4 === 2
            ? { state: 'skipped', at: now() }
            : { state: 'done', at: now() };
    const span = (from: number, to: number, make = entry) =>
      Object.fromEntries(
        Array.from({ length: Math.min(to, 31) - from }, (_, j) => [key(from + j), make(from + j)]),
      );
    const answered = () => ({ state: 'done', at: now(), answer: sealed(4000) });
    // Created with four days, every one answered at the bound.
    await assertSucceeds(ref.set({ ...habitLog(), month: '2026-12', days: span(0, 4, answered) }));
    // Then four days a write, by merge, to the end of the month.
    for (let from = 4; from < 31; from += 4) {
      await assertSucceeds(
        ref.set({ days: span(from, from + 4), updatedAt: now() }, { merge: true }),
      );
    }
    const stored = (await ref.get()).data()?.['days'] as Record<string, unknown>;
    if (Object.keys(stored).length !== 31) throw new Error('the month is not full');
    // A tick on the full month: the request holds all 31 entries.
    await assertSucceeds(
      ref.update({
        'days.06': { state: 'done', at: now(), answer: sealed(4000) },
        updatedAt: now(),
      }),
    );
    // The whole map written back, four of its days changed, each
    // answered at the bound: only those four are checked.
    const read = async () => (await ref.get()).data()?.['days'] as Record<string, unknown>;
    await assertSucceeds(
      ref.update({ days: { ...(await read()), ...span(10, 14, answered) }, updatedAt: now() }),
    );
    await assertSucceeds(
      ref.set({
        ...habitLog(),
        month: '2026-12',
        days: { ...(await read()), ...span(20, 24, answered) },
      }),
    );
    // Five days in one write are over the cap, on update and on create.
    await assertFails(ref.update({ days: { ...(await read()), ...span(25, 30, answered) } }));
    await assertFails(
      owner()
        .doc('users/owner/habitLogs/h1_2027-01')
        .set({ ...habitLog(), month: '2027-01', days: span(0, 5) }),
    );
    // So a full month cannot be written in one go: built a few days a
    // write, as ticks build it.
    await assertFails(
      owner()
        .doc('users/owner/habitLogs/h1_2027-01')
        .set({ ...habitLog(), month: '2027-01', days: span(0, 31) }),
    );
    // A bad day among the full month's is still caught.
    await assertFails(
      ref.update({ 'days.31': { state: 'skipped', at: now(), noteId: 'n' }, updatedAt: now() }),
    );
    await assertFails(ref.update({ 'days.31': 'done', updatedAt: now() }));
    // A day removed is not an entry to check.
    await assertSucceeds(ref.update({ 'days.31': firebase.firestore.FieldValue.delete() }));
  });
});

describe('function-only collections: notes/history, activity, runs', () => {
  for (const path of [
    'users/owner/notes/n1/history/v1',
    'users/owner/activity/run1',
    'users/owner/runs/run1',
  ]) {
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
