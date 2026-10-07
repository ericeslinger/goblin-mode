import { deleteApp, initializeApp } from 'firebase-admin/app';
import { type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotesTools, ToolError } from './tools';

// Runs inside `npm run e2e`, against the e2e Firestore emulator, under
// its own project id so it never touches journey or rules-test data.
const PROJECT = 'demo-mossgoblin-mcp';
const HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8180';
const app = initializeApp({ projectId: PROJECT }, 'mcp-tools-spec');
let db: Firestore;
const T = Date.parse('2026-10-06T14:00:00Z');

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

const tools = () => new NotesTools(db, 'u1', () => T);

async function eric(id: string, body: string, over: Record<string, unknown> = {}) {
  await db.doc(`users/u1/notes/${id}`).set({
    kind: 'text',
    body,
    title: body.split('\n')[0],
    titleSource: 'words',
    links: [],
    tags: [],
    archived: false,
    createdAt: Timestamp.fromMillis(T - 1000),
    updatedAt: Timestamp.fromMillis(T - 1000),
    updatedBy: 'user',
    deviceId: 'phone',
    ...over,
  });
}

describe('NotesTools', () => {
  it('creates a note Claude wrote, in the full contract shape', async () => {
    const { id } = await tools().createNote({
      body: 'Card for the nephew\nHe likes trains',
      tags: ['family'],
    });
    const doc = (await db.doc(`users/u1/notes/${id}`).get()).data()!;
    expect(doc).toMatchObject({
      body: 'Card for the nephew\nHe likes trains',
      title: 'Card for the nephew',
      titleSource: 'words',
      tags: ['family'],
      updatedBy: 'claude',
      deviceId: 'claude',
      archived: false,
    });
    expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  it('searches, lists and reads notes, with backlinks, leaving archived ones out', async () => {
    await eric('a', 'Project Hotswap\nsync with Vikas', { title: 'Plan A' });
    // No stored links: backlinks come from the body.
    await eric('b', 'Groceries\nask about [[plan a]]');
    await eric('c', 'Old hotswap plan', { archived: true });
    const t = tools();
    expect((await t.searchNotes({ query: 'hotswap vikas' })).map((n) => n.id)).toEqual(['a']);
    expect(
      (await t.searchNotes({ query: 'hotswap', includeArchived: true })).map((n) => n.id).sort(),
    ).toEqual(['a', 'c']);
    expect((await t.listNotes({})).map((n) => n.id).sort()).toEqual(['a', 'b']);
    const note = await t.getNote({ id: 'a' });
    expect(note).toMatchObject({
      body: 'Project Hotswap\nsync with Vikas',
      backlinks: [{ id: 'b', title: 'Groceries' }],
    });
    await expect(t.getNote({ id: 'zz' })).rejects.toBeInstanceOf(ToolError);
  });

  it('stores the ids a note links to, when Claude writes it', async () => {
    await eric('v', 'Vikas', { kind: 'concept', synonyms: ['Vik'] });
    const t = tools();
    const { id } = await t.createNote({ body: 'Lunch with [[vik]] about [[Pottery]]' });
    expect((await db.doc(`users/u1/notes/${id}`).get()).get('links')).toEqual(['v', 'c-pottery']);
    await t.updateNote({ id, body: 'Lunch moved; ask [[Vikas]]' });
    expect((await db.doc(`users/u1/notes/${id}`).get()).get('links')).toEqual(['v']);
  });

  it("updates a note as Claude, keeping Eric's own title his", async () => {
    await eric('a', 'first draft');
    await eric('m', 'mine', { title: 'Mine', titleSource: 'user' });
    const t = tools();
    await t.updateNote({ id: 'a', body: 'first draft\n\nClaude added this', tags: ['x'] });
    expect((await db.doc('users/u1/notes/a').get()).data()).toMatchObject({
      body: 'first draft\n\nClaude added this',
      tags: ['x'],
      updatedBy: 'claude',
      deviceId: 'claude',
    });
    await expect(t.updateNote({ id: 'm', title: 'Better' })).rejects.toThrow(/Eric's own/);
    await expect(t.updateNote({ id: 'a', body: '  ' })).rejects.toBeInstanceOf(ToolError);
    await t.updateNote({ id: 'a', archived: true });
    expect((await db.doc('users/u1/notes/a').get()).get('archived')).toBe(true);
  });

  it('creates, snoozes and finishes reminders through the shared rules', async () => {
    const t = tools();
    const due = '2026-10-07T01:00:00Z';
    const r = await t.createReminder({
      text: 'Journal',
      dueAt: due,
      repeat: 'daily',
      timeZone: 'America/New_York',
    });
    expect(r).toMatchObject({
      text: 'Journal',
      status: 'open',
      dueAt: '2026-10-07T01:00:00.000Z',
      recurrence: { freq: 'daily', time: '21:00', tz: 'America/New_York' },
      createdBy: 'claude',
    });
    await expect(t.createReminder({ text: 'x', repeat: 'daily' })).rejects.toThrow(/timeZone/);
    await expect(t.createReminder({ text: 'x', dueAt: 'tomorrow' })).rejects.toThrow(/ISO 8601/);

    const snoozed = await t.updateReminder({ id: r.id, snoozeUntil: '2026-10-07T02:00:00Z' });
    expect(snoozed).toMatchObject({ status: 'snoozed', nextDue: '2026-10-07T02:00:00.000Z' });
    const done = await t.updateReminder({ id: r.id, done: true });
    expect(done).toMatchObject({ status: 'open', dueAt: '2026-10-08T01:00:00.000Z' });
    const stored = (await db.doc(`users/u1/reminders/${r.id}`).get()).data()!;
    expect(stored['snoozedUntil']).toBeUndefined();

    const once = await t.createReminder({ text: 'Call the bank' });
    await t.updateReminder({ id: once.id, done: true });
    expect(await t.listReminders({})).toHaveLength(1);
    expect(await t.listReminders({ includeDone: true })).toHaveLength(2);
  });
});
