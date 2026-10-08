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

async function concept(id: string, title: string, over: Record<string, unknown> = {}) {
  await eric(id, '', { kind: 'concept', title, ...over });
}

/** Tools whose clock moves a second per call, so runs sort in order. */
function ticking() {
  let t = T;
  return new NotesTools(db, 'u1', () => (t += 1000));
}

async function runs() {
  const snap = await db.collection('users/u1/activity').orderBy('at').get();
  return snap.docs.map((d) => d.data());
}

const body = async (id: string) => (await db.doc(`users/u1/notes/${id}`).get()).data()!;

describe('organizing tools', () => {
  it('records every write as a run in activity, in the same commit', async () => {
    const t = ticking();
    const { id } = await t.createNote({ body: 'Seed list\nkale' });
    await t.updateNote({ id, body: 'Seed list\nkale, chard', tags: ['garden'] });
    await t.createReminder({ text: 'Water seeds' });
    expect(await runs()).toEqual([
      expect.objectContaining({
        tool: 'create_note',
        summary: 'Wrote a new note',
        notes: [{ id, title: 'Seed list' }],
        reminders: [],
      }),
      expect.objectContaining({
        tool: 'update_note',
        summary: "Changed a note's text and tags",
        notes: [{ id, title: 'Seed list' }],
      }),
      expect.objectContaining({
        tool: 'create_reminder',
        reminders: [expect.objectContaining({ title: 'Water seeds' })],
      }),
    ]);
  });

  it('lists concepts by links and finds backlinks with their sentence', async () => {
    await concept('c-kiln', 'Kiln', { conceptType: 'project', synonyms: ['The kiln'] });
    await concept('c-vikas', 'Vikas', { conceptType: 'person' });
    await eric('a', 'Studio day\nFire the [[kiln]]. Then glaze.');
    await eric('b', 'Ask [[Vikas]] about [[The kiln]].');
    await eric('gone', 'Old [[Kiln]] plan', { archived: true });
    const t = ticking();
    expect(await t.listConcepts({})).toEqual([
      { id: 'c-kiln', title: 'Kiln', type: 'project', synonyms: ['The kiln'], linkedFrom: 2 },
      { id: 'c-vikas', title: 'Vikas', type: 'person', synonyms: [], linkedFrom: 1 },
    ]);
    expect((await t.listConcepts({ type: 'person' })).map((c) => c.id)).toEqual(['c-vikas']);
    const back = await t.getBacklinks({ id: 'c-kiln' });
    expect(back.map((b) => [b.id, b.sentence]).sort()).toEqual([
      ['a', 'Fire the [[kiln]].'],
      ['b', 'Ask [[Vikas]] about [[The kiln]].'],
    ]);
  });

  it('links a note with a line of its own, leaving the text and existing links alone', async () => {
    await eric('a', 'Studio day\nFire the kiln.\n');
    await eric('b', 'Glaze recipes');
    await eric('c', 'Kiln repair');
    await eric('dup', 'Glaze recipes');
    const t = ticking();
    expect(await t.linkNotes({ from: 'a', to: ['b', 'c'] })).toMatchObject({
      linked: [{ id: 'b' }, { id: 'c' }],
    });
    const a = await body('a');
    expect(a['body']).toBe(
      'Studio day\nFire the kiln.\n\nSee also [[Glaze recipes]], [[Kiln repair]]',
    );
    expect(a['links']).toEqual(['b', 'c']);
    // Already linked: nothing to do, and no run recorded.
    expect(await t.linkNotes({ from: 'a', to: ['c'] })).toEqual({ id: 'a', linked: [] });
    // "Glaze recipes" reaches b, not dup, so dup cannot be linked by name.
    await expect(t.linkNotes({ from: 'a', to: ['dup'] })).rejects.toThrow(ToolError);
    expect((await runs()).map((r) => r['summary'])).toEqual(['Linked a note to 2 others']);
  });

  it('splits a note only word for word, linking the new notes from what is left', async () => {
    await eric('a', 'Kiln day\nFire to cone 6.\n\nGlaze notes\nCeladon ran.', { tags: ['clay'] });
    const t = ticking();
    await expect(
      t.splitNote({ id: 'a', parts: ['Kiln day\nFire to cone six.', 'Glaze notes\nCeladon ran.'] }),
    ).rejects.toThrow('part 1 is not the next piece of the note word for word');
    const { pieces } = await t.splitNote({
      id: 'a',
      parts: ['Kiln day\nFire to cone 6.', 'Glaze notes\nCeladon ran.'],
    });
    expect(pieces).toEqual([{ id: expect.any(String), title: 'Glaze notes' }]);
    const piece = await body(pieces[0].id);
    expect(piece).toMatchObject({
      body: 'Glaze notes\nCeladon ran.',
      title: 'Glaze notes',
      tags: ['clay'],
      updatedBy: 'claude',
    });
    const a = await body('a');
    expect(a['body']).toBe('Kiln day\nFire to cone 6.\n\nSplit off: [[Glaze notes]]');
    expect(a['links']).toEqual([pieces[0].id]);
    const [run] = await runs();
    expect(run).toMatchObject({ tool: 'split_note', summary: 'Split a note into 2' });
    expect(run['notes'].map((n: { id: string }) => n.id)).toEqual(['a', pieces[0].id]);
  });

  it('merges into a new note, archiving the originals; links to them follow', async () => {
    await eric('a', 'Kiln log\nCone 6, slow cool.', {
      tags: ['clay'],
      createdAt: Timestamp.fromMillis(T - 5000),
    });
    await eric('b', 'Firing notes\nShelf 2 cracked, see [[Kiln log]].', { tags: ['kiln'] });
    await eric('c', 'Todo\ncheck the [[Firing notes]]');
    const t = ticking();
    const { id } = await t.mergeNotes({ ids: ['a', 'b'] });
    const merged = await body(id);
    expect(merged).toMatchObject({
      body: 'Kiln log\nCone 6, slow cool.\n\nFiring notes\nShelf 2 cracked, see [[Kiln log]].',
      links: [],
      title: 'Kiln log',
      titleSource: 'words',
      synonyms: ['Firing notes'],
      tags: ['clay', 'kiln'],
      archived: false,
    });
    expect((merged['createdAt'] as Timestamp).toMillis()).toBe(T - 5000);
    expect(await body('a')).toMatchObject({ archived: true, mergedInto: id });
    expect(await body('b')).toMatchObject({ archived: true, mergedInto: id });
    expect((await t.getBacklinks({ id })).map((b) => b.id)).toEqual(['c']);
    await expect(t.mergeNotes({ ids: ['a', 'c'] })).rejects.toThrow('note a is archived');
    expect((await runs()).map((r) => r['summary'])).toEqual(['Merged 2 notes into one']);
  });

  it('creates a concept links can reach, refusing a name already taken', async () => {
    await eric('a', 'Glaze recipes');
    const t = ticking();
    expect(
      await t.createConcept({
        name: 'Gradebook',
        type: 'project',
        synonyms: ['stubgrub', 'gradint party'],
        body: 'Part of [[Glaze recipes]].',
        tags: ['build', 'maintenance'],
      }),
    ).toEqual({ id: 'c-gradebook', title: 'Gradebook', type: 'project' });
    expect(await body('c-gradebook')).toMatchObject({
      kind: 'concept',
      title: 'Gradebook',
      titleSource: 'user',
      conceptType: 'project',
      synonyms: ['stubgrub', 'gradint party'],
      links: ['a'],
      tags: ['build', 'maintenance'],
      updatedBy: 'claude',
    });
    await expect(t.createConcept({ name: 'gradebook' })).rejects.toThrow('already a name');
    await expect(t.createConcept({ name: 'Kiln', synonyms: ['Stubgrub'] })).rejects.toThrow(
      'already a name in the garden: Stubgrub',
    );
    await expect(t.createConcept({ name: 'glaze recipes' })).rejects.toThrow('already a name');
    // Names and tags trimmed and once each; the name is not its own other name.
    await t.createConcept({
      name: 'Sprout',
      synonyms: [' sprout ', 'Sprout lang', 'sprout lang'],
      tags: ['build ', 'build', ' active'],
    });
    expect(await body('c-sprout')).toMatchObject({
      synonyms: ['Sprout lang'],
      tags: ['build', 'active'],
    });
    await expect(t.createConcept({ name: 'x'.repeat(121) })).rejects.toThrow('at most 120');
    expect((await runs()).map((r) => r['summary'])).toEqual([
      'Made Gradebook a project',
      'Made Sprout a concept',
    ]);
  });

  it('refiles a concept, refusing names another note answers to', async () => {
    await concept('c-kiln', 'Kiln');
    await eric('a', 'Glaze recipes', { tags: ['clay'] });
    const t = ticking();
    expect(
      await t.refile({
        id: 'c-kiln',
        type: 'project',
        addSynonyms: ['The kiln', 'glaze recipes', 'kiln'],
      }),
    ).toEqual({
      id: 'c-kiln',
      changed: ['filed as a project', 'added another name: The kiln'],
      refused: ['glaze recipes'],
    });
    expect(await body('c-kiln')).toMatchObject({ conceptType: 'project', synonyms: ['The kiln'] });
    await expect(t.refile({ id: 'a', type: 'person' })).rejects.toThrow(
      'only a concept has a type and other names',
    );
    await t.refile({ id: 'a', addTags: ['pottery'], removeTags: ['clay'] });
    expect((await body('a'))['tags']).toEqual(['pottery']);
    expect((await runs()).map((r) => r['summary'])).toEqual([
      'Refiled Kiln: filed as a project; added another name: The kiln',
      'Refiled Glaze recipes: tagged pottery; untagged clay',
    ]);
  });

  it('archives and restores a note, recording each', async () => {
    await eric('a', 'Old plan');
    const t = ticking();
    await t.archiveNote({ id: 'a' });
    expect((await body('a'))['archived']).toBe(true);
    await t.archiveNote({ id: 'a' });
    await t.archiveNote({ id: 'a', archived: false });
    expect((await runs()).map((r) => r['summary'])).toEqual(['Archived a note', 'Restored a note']);
  });
});

describe('template tools', () => {
  const TEMPLATE =
    'Shopping list\n## Produce\n\n## Instructions for Claude\nStart from the meal plan.';

  it('lists templates with their instructions, skeleton, mode and schedule', async () => {
    await eric('t1', TEMPLATE, { kind: 'template', templateMode: 'living' });
    await eric('t2', 'Journal\nMood:', { kind: 'template' });
    await eric('gone', 'Old', { kind: 'template', archived: true });
    await eric('n1', 'Not a template');
    await db.doc('users/u1/reminders/r1').set({
      text: 'Journal',
      status: 'open',
      createdBy: 'user',
      template: 't2',
      recurrence: { freq: 'daily', time: '21:00', tz: 'UTC' },
    });
    await db.doc('users/u1/reminders/r2').set({ text: 'Plain', status: 'open', createdBy: 'user' });
    const list = await tools().listTemplates();
    expect(list.map((t) => [t.id, t.mode])).toEqual([
      ['t2', 'entry'],
      ['t1', 'living'],
    ]);
    expect(list[1]).toMatchObject({
      instructions: 'Start from the meal plan.',
      skeleton: 'Shopping list\n## Produce',
      schedule: [],
    });
    expect(list[0].schedule.map((r) => r.id)).toEqual(['r1']);
  });

  it('opens a living template’s one note, making it the first time', async () => {
    await eric('t1', TEMPLATE, { kind: 'template', templateMode: 'living' });
    const t = ticking();
    const first = await t.useTemplate({ id: 't1' });
    expect(first).toMatchObject({
      template: { id: 't1', title: 'Shopping list', mode: 'living' },
      instructions: 'Start from the meal plan.',
      created: true,
      note: { body: 'Shopping list\n## Produce' },
    });
    expect((await body(first.note.id))['fromTemplate']).toBe('t1');
    const again = await t.useTemplate({ id: 't1' });
    expect(again).toMatchObject({ created: false, note: { id: first.note.id } });
    expect((await runs()).map((r) => r['summary'])).toEqual(['Started a note from Shopping list']);
  });

  it('starts a new entry each time, and refuses what is not a template', async () => {
    await eric('t2', 'Journal\nMood:', { kind: 'template', templateMode: 'entry' });
    await eric('n1', 'Not a template');
    const t = ticking();
    const a = await t.useTemplate({ id: 't2' });
    const b = await t.useTemplate({ id: 't2' });
    expect(a.note.id).not.toBe(b.note.id);
    await expect(t.useTemplate({ id: 'n1' })).rejects.toThrow('no template n1');
  });
});

describe('line tools', () => {
  const LIST = 'Shopping list\n## Produce\n- [ ] apples\n\n## Dry goods\n- [ ] rice';

  it('adds under a heading and ticks items, on the current text, recording each', async () => {
    await eric('s', LIST);
    const t = ticking();
    // Eric ticks rice on his phone; Claude's add lands on that text.
    await db.doc('users/u1/notes/s').update({ body: LIST.replace('- [ ] rice', '- [x] rice') });
    await t.addLines({ id: 's', heading: 'Produce', lines: ['- [ ] limes'] });
    await t.checkItem({ id: 's', item: 'apples' });
    expect((await body('s'))['body']).toBe(
      'Shopping list\n## Produce\n- [x] apples\n- [ ] limes\n\n## Dry goods\n- [x] rice',
    );
    await t.uncheckItem({ id: 's', item: 'rice' });
    expect((await body('s'))['body']).toContain('- [ ] rice');
    expect(await t.checkItem({ id: 's', item: 'apples' })).toEqual({ id: 's', changed: false });
    await expect(t.checkItem({ id: 's', item: 'bread' })).rejects.toThrow(/no item matches/);
    expect((await runs()).map((r) => r['summary'])).toEqual([
      'Added 1 line to Shopping list, under Produce',
      'Ticked apples',
      'Unticked rice',
    ]);
  });

  it('keeps both of two edits made at once', async () => {
    await eric('s', LIST);
    const t = ticking();
    await Promise.all([
      t.addLines({ id: 's', heading: 'Dry goods', lines: ['- [ ] oats'] }),
      t.checkItem({ id: 's', item: 'apples' }),
      t.addLines({ id: 's', heading: 'Butcher', lines: ['- [ ] chicken'] }),
    ]);
    const text = String((await body('s'))['body']);
    expect(text).toContain('- [x] apples');
    expect(text).toContain('- [ ] rice\n- [ ] oats');
    expect(text).toContain('## Butcher\n- [ ] chicken');
  });
});
