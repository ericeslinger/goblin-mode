import {
  type DataKey,
  type SealReport,
  aadFor,
  addSealReports,
  assignedItems,
  isKeyedHash,
  isSealed,
  itemHash,
  newDataKey,
  noteTextHash,
  openText,
  recordAadFor,
  refileNamesHash,
  sealText,
  summarySaysText,
  textHash,
  rerouteNotes,
  RUN_STALE_MS,
  digestSentence,
} from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runRequested } from '../agent/core';
import { assignedOnWrite } from '../agent/assigned';
import { itemRunId } from '../agent/items';
import { gardenOnArrival } from '../agent/request';
import { NoteCodec, sealingIn } from '../mcp/note-text';
import { NotesTools } from '../mcp/tools';
import { putBack } from '../putback/firestore';
import { keyOf, refileNames } from '../organize/proposals';
import { NoteKeysUnconfigured } from '../note-keys/client';
import { type Data, type Store, copy, fakeDb, snapAt } from '../testing/fake-firestore';
import { historyOnWrite, titleOnWrite } from './on-write';
import {
  IMPORT_FRESH_MS,
  MAX_DOC_BYTES,
  SealingTurnedOff,
  UNKEPT_TEXT,
  hashedRefileKey,
  relabelSummary,
  sealAllPass,
  sealNote,
} from './seal-all';
import { SealAllRefused, sealEverythingFor, sealRequestOf } from './seal-everything';

// Seal everything now (the migration, Eric, 2026-11-15): plain in,
// sealed out, over the in-memory Firestore with a fake key source; the
// plaintext appears nowhere in the stored documents afterwards (but in
// replaced texts, left to expire); a second pass writes nothing; and
// no trigger reacts to a write that changed only the form of text.

const UID = 'u1';
const OTHER = 'u2';
const T = Date.parse('2026-11-15T10:00:00Z');
const base = `users/${UID}`;
const notePath = (id: string, uid = UID) => `users/${uid}/notes/${id}`;

let store: Store;
let key: DataKey;
let keyFor: ReturnType<typeof vi.fn<(uid: string) => Promise<DataKey>>>;

const ts = (ms: number) => Timestamp.fromMillis(ms);
const seal = (id: string, field: Parameters<typeof aadFor>[2], text: string, k = key) =>
  sealText(k, aadFor(UID, id, field), text);
const open = (id: string, field: Parameters<typeof aadFor>[2], value: unknown) =>
  openText(key, aadFor(UID, id, field), String(value));
const keyedBody = (id: string, text: string) => noteTextHash(id, text, 'sealed', () => key)!;

function note(body: string, over: Data = {}): Data {
  return {
    kind: 'text',
    body,
    title: body.split('\n')[0],
    titleSource: 'words',
    links: [],
    tags: [],
    archived: false,
    createdAt: ts(T - 86_400_000),
    updatedAt: ts(T - 60_000),
    settledAt: ts(T - 50_000),
    updatedBy: 'user',
    deviceId: 'phone',
    ...over,
  };
}

/** Every document of the gardener's but the replaced texts, as one string. */
const everything = (s: Store = store) =>
  JSON.stringify([...s].filter(([p]) => p.startsWith(`${base}/`) && !p.includes('/replaced/')));

const sealingOn = () => store.set(`${base}/settings/assistant`, { sealNotes: true });

const deps = (over: Partial<Parameters<typeof sealAllPass>[0]> = {}) => {
  const db = fakeDb(store);
  return {
    db,
    codec: new NoteCodec(UID, keyFor, sealingIn(db, UID)),
    uid: UID,
    dryRun: false,
    deadline: Infinity,
    now: () => T,
    stillOn: sealingIn(db, UID),
    log: () => undefined,
    ...over,
  };
};

/** A whole pass, cursor to cursor. */
async function passAll(
  dryRun = false,
  over: Partial<Parameters<typeof sealAllPass>[0]> = {},
): Promise<SealReport> {
  let out = await sealAllPass(deps({ dryRun, ...over }));
  let report = out.report;
  while (!out.done) {
    out = await sealAllPass(deps({ dryRun, ...over }), out.cursor);
    report = addSealReports(report, out.report);
  }
  return report;
}

const ITEM_TEXT = 'find a kiln shelf supplier';
const ITEM_BODY = `Pottery\n- [x] ${ITEM_TEXT} @goblin`;

/** A garden from before the switch: every kind of record, all plain. */
function seedPlainGarden() {
  sealingOn();
  store.set(
    notePath('n1'),
    note('Shed roof leaks\nby the east gutter', {
      baseHash: textHash('Shed roof\nby the east gutter'),
      instructions: 'Keep the gutter list short',
      sendAsk: 'Find a roofer near the orchard',
      sendOutcome: 'Rang the orchard roofer',
    }),
  );
  store.set(
    notePath('c-quince'),
    note('Quince tree notes', {
      kind: 'concept',
      title: 'Quince',
      titleSource: 'user',
      synonyms: ['Cydonia', seal('c-quince', 'synonyms', 'Pear quince')],
      archived: true,
    }),
  );
  store.set(
    notePath('r1'),
    note('Damson jam\n## Method\nBoil', {
      kind: 'recipe',
      importState: 'failed',
      importError: 'The damson page would not load',
      source: { url: 'https://example.com/damson', text: 'Damson page words' },
      deletedAt: ts(T - 1000),
    }),
  );
  store.set(
    notePath('context'),
    note('Context for Claude\n- Put back: Shed roof leaks was filed wrong', {
      title: 'Context for Claude',
    }),
  );
  store.set(notePath('i1'), note(ITEM_BODY));
  // History: the text n1 was written over, plain.
  store.set(`${notePath('n1')}/history/v1`, {
    body: 'Shed roof\nby the east gutter',
    title: 'Shed roof',
    updatedBy: 'user',
    deviceId: 'laptop',
    updatedAt: ts(T - 120_000),
    savedAt: ts(T - 110_000),
    reason: 'device',
  });
  // A replaced text, plain under a plain id: left to expire.
  store.set(`${notePath('n1')}/replaced/${textHash('Shed roof was')}`, {
    body: 'Shed roof was',
    writtenAt: ts(T - 100_000),
    expireAt: ts(T + 86_400_000),
  });
  store.set(`${base}/proposals/p1`, {
    kind: 'merge',
    reason: 'Shed roof and gutter are one job',
    notes: [
      { id: 'n1', title: 'Shed roof leaks' },
      { id: 'i1', title: 'Pottery' },
    ],
    title: 'Shed roof and gutters',
    key: 'merge:i1,n1',
    status: 'applied',
    outcome: 'Merged into Shed roof and gutters',
    createdAt: ts(T - 5000),
  });
  store.set(`${base}/proposals/p2`, {
    kind: 'refile',
    reason: 'Quince is a plant',
    notes: [{ id: 'c-quince', title: 'Quince' }],
    conceptType: 'other',
    synonyms: ['Marmelo'],
    key: 'refile:c-quince:other:marmelo',
    status: 'open',
    createdAt: ts(T - 5000),
  });
  const plainRun = itemRunId(
    'i1',
    itemHash('i1', ITEM_TEXT, 'plain', () => undefined)!,
  );
  store.set(`${base}/runs/${plainRun}`, {
    kind: 'item',
    noteId: 'i1',
    itemText: ITEM_TEXT,
    itemKey: ITEM_TEXT,
    status: 'done',
    outcome: 'Found Kilnworks in the next valley',
    attempt: 1,
    steps: [{ tool: 'web_search', ok: true, at: ts(T - 4000) }],
    createdAt: ts(T - 5000),
  });
  store.set(`${base}/runs/sent1`, {
    kind: 'queued-note',
    noteId: 'n1',
    status: 'done',
    outcome: 'Rang the orchard roofer',
    steps: [],
    createdAt: ts(T - 5000),
  });
  store.set(`${base}/activity/a1`, {
    at: ts(T - 3000),
    tool: 'add_lines',
    summary: 'Added 1 line to Shed roof leaks',
    notes: [{ id: 'n1', title: 'Shed roof leaks' }],
    reminders: [],
  });
  store.set(`${base}/activity/a2`, {
    at: ts(T - 2000),
    tool: 'refile',
    summary: 'Quince: added names Cydonia; filed under Orchard',
    notes: [
      {
        id: 'c-quince',
        title: 'Quince',
        before: {
          synonyms: ['Cydonia'],
          parent: null,
          body: textHash('Shed roof\nby the east gutter'),
        },
      },
    ],
    reminders: [],
  });
  store.set(`${base}/activity/a3`, {
    at: ts(T - 1000),
    tool: 'update_note',
    summary: "Changed a note's text and title",
    notes: [{ id: 'n1', title: 'Shed roof leaks' }],
    reminders: [],
  });
  store.set(`${base}/activity/a4`, {
    at: ts(T - 1000),
    tool: 'create_reminder',
    summary: 'Reminded you to call the roofer',
    notes: [],
    reminders: [{ id: 'rem1', title: 'call the roofer' }],
  });
  // Another gardener's note: never touched.
  store.set(notePath('n1', OTHER), note('Shed roof leaks elsewhere'));
  return { plainRun };
}

/** Words from the garden above that must not be left in the clear. */
const WORDS = [
  'Shed roof',
  'east gutter',
  'gutter list',
  'orchard',
  'Quince tree',
  'Cydonia',
  'Damson',
  'damson page',
  'Context for Claude',
  'filed wrong',
  'kiln shelf',
  'Kilnworks',
  'one job',
  'and gutters',
  'Marmelo',
  'Pottery',
  'Orchard',
];

beforeEach(() => {
  store = new Map();
  key = newDataKey();
  keyFor = vi.fn(async (uid: string) => {
    if (uid !== UID) throw new Error('another gardener');
    return key;
  });
});

describe('seal everything now', () => {
  it('seals every kind of record, and no word is left in the clear', async () => {
    const { plainRun } = seedPlainGarden();
    const otherBefore = JSON.stringify(store.get(notePath('n1', OTHER)));
    const report = await passAll();

    const stored = everything();
    for (const w of WORDS) expect(stored, w).not.toContain(w);
    // Another gardener's note keeps its words.
    expect(JSON.stringify(store.get(notePath('n1', OTHER)))).toBe(otherBefore);

    // Notes: every sealed field, archived and in Trash too, opens to its text.
    const n1 = store.get(notePath('n1'))!;
    expect(open('n1', 'body', n1['body'])).toBe('Shed roof leaks\nby the east gutter');
    expect(open('n1', 'title', n1['title'])).toBe('Shed roof leaks');
    expect(open('n1', 'instructions', n1['instructions'])).toBe('Keep the gutter list short');
    expect(open('n1', 'sendAsk', n1['sendAsk'])).toBe('Find a roofer near the orchard');
    expect(open('n1', 'sendOutcome', n1['sendOutcome'])).toBe('Rang the orchard roofer');
    // Nothing but the form: who wrote it and when stay.
    expect(n1['updatedAt']).toEqual(ts(T - 60_000));
    expect(n1['deviceId']).toBe('phone');
    expect(n1['updatedBy']).toBe('user');
    // Its base, found in History, keyed: the same text.
    expect(n1['baseHash']).toBe(keyedBody('n1', 'Shed roof\nby the east gutter'));
    const quince = store.get(notePath('c-quince'))!;
    expect((quince['synonyms'] as string[]).map((s) => open('c-quince', 'synonyms', s))).toEqual([
      'Cydonia',
      'Pear quince',
    ]);
    const r1 = store.get(notePath('r1'))!;
    expect(open('r1', 'importError', r1['importError'])).toBe('The damson page would not load');
    const source = r1['source'] as Data;
    expect(source['url']).toBe('https://example.com/damson');
    expect(open('r1', 'source.text', source['text'])).toBe('Damson page words');
    expect(open('context', 'body', store.get(notePath('context'))!['body'])).toContain(
      'filed wrong',
    );

    // History, in place, opening with the note's aad.
    const v1 = store.get(`${notePath('n1')}/history/v1`)!;
    expect(open('n1', 'body', v1['body'])).toBe('Shed roof\nby the east gutter');
    expect(v1['reason']).toBe('device');

    // Replaced texts: left as they are, and counted.
    expect(store.get(`${notePath('n1')}/replaced/${textHash('Shed roof was')}`)!['body']).toBe(
      'Shed roof was',
    );
    expect(report.replaced).toEqual({
      plain: 1,
      lastExpiresAt: new Date(T + 86_400_000).toISOString(),
    });

    // Suggestions: sealed under their own ids, names labelled, refile names out.
    const p1 = store.get(`${base}/proposals/p1`)!;
    expect(
      openText(key, recordAadFor(UID, 'proposals', 'p1', 'reason'), String(p1['reason'])),
    ).toBe('Shed roof and gutter are one job');
    expect(openText(key, recordAadFor(UID, 'proposals', 'p1', 'title'), String(p1['title']))).toBe(
      'Shed roof and gutters',
    );
    expect((p1['notes'] as Data[]).map((n) => n['title'])).toEqual(['Sealed note', 'Sealed note']);
    expect(p1['outcome']).toBe('Merged into a sealed note');
    const p2 = store.get(`${base}/proposals/p2`)!;
    // Its proposed names kept, sealed under the suggestion's own id, and
    // its key the one a new suggestion of the same change gets.
    expect(
      (p2['synonyms'] as string[]).map((n) =>
        openText(key, recordAadFor(UID, 'proposals', 'p2', 'synonyms'), n),
      ),
    ).toEqual(['Marmelo']);
    expect(p2['key']).toBe(
      `refile:c-quince:other:${refileNamesHash('c-quince', 'marmelo', () => key)}`,
    );
    expect(p2['status']).toBe('open');

    // Runs: the item run moved to its keyed id, its text sealed under it.
    expect(store.has(`${base}/runs/${plainRun}`)).toBe(false);
    const keyedRun = itemRunId(
      'i1',
      itemHash('i1', ITEM_TEXT, 'sealed', () => key)!,
    );
    const moved = store.get(`${base}/runs/${keyedRun}`)!;
    const runOpen = (id: string, f: 'itemText' | 'itemKey' | 'outcome', v: unknown) =>
      openText(key, recordAadFor(UID, 'runs', id, f), String(v));
    expect(runOpen(keyedRun, 'itemText', moved['itemText'])).toBe(ITEM_TEXT);
    expect(runOpen(keyedRun, 'itemKey', moved['itemKey'])).toBe(ITEM_TEXT);
    expect(runOpen(keyedRun, 'outcome', moved['outcome'])).toBe(
      'Found Kilnworks in the next valley',
    );
    expect(moved['status']).toBe('done');
    expect(moved['createdAt']).toEqual(ts(T - 5000));
    const sent = store.get(`${base}/runs/sent1`)!;
    expect(runOpen('sent1', 'outcome', sent['outcome'])).toBe('Rang the orchard roofer');

    // Activity: relabelled, never deleted; fields before sealed as stored.
    const a1 = store.get(`${base}/activity/a1`)!;
    // The digest still counts its line.
    expect(a1['summary']).toBe('Added 1 line to a sealed note');
    expect((a1['notes'] as Data[])[0]['title']).toBe('Sealed note');
    const a2 = store.get(`${base}/activity/a2`)!;
    expect(a2['summary']).toBe('Changed a sealed note; filed under a sealed project');
    const before = (a2['notes'] as Data[])[0]['before'] as Data;
    expect((before['synonyms'] as string[]).map((s) => open('c-quince', 'synonyms', s))).toEqual([
      'Cydonia',
    ]);
    expect(before['parent']).toBeNull();
    // Its text was not c-quince's: kept nowhere, so a keyed hash of nothing.
    expect(before['body']).toBe(keyedBody('c-quince', UNKEPT_TEXT));
    const a3 = store.get(`${base}/activity/a3`)!;
    expect(a3['summary']).toBe("Changed a note's text and title");
    expect(store.get(`${base}/activity/a4`)!['reminders']).toEqual([
      { id: 'rem1', title: 'call the roofer' },
    ]);

    expect(report.sealed).toEqual({ notes: 5, versions: 1, suggestions: 2, runs: 2, activity: 3 });
    expect(report.runsMoved).toBe(1);
    expect(report.hashesUnkept).toBe(1);
    expect(keyFor.mock.calls.every(([uid]) => uid === UID)).toBe(true);
  });

  it('writes nothing on a second pass', async () => {
    seedPlainGarden();
    await passAll();
    const after = everything();
    const again = await passAll();
    expect(everything()).toBe(after);
    expect(again.sealed).toEqual({ notes: 0, versions: 0, suggestions: 0, runs: 0, activity: 0 });
    expect(again.runsMoved).toBe(0);
  });

  it('counts in a dry run what a pass then does, and writes nothing', async () => {
    seedPlainGarden();
    const was = JSON.stringify([...store]);
    const dry = await passAll(true);
    expect(JSON.stringify([...store])).toBe(was);
    expect(dry.dryRun).toBe(true);
    const done = await passAll();
    expect(dry.sealed).toEqual(done.sealed);
    expect(dry.runsMoved).toBe(done.runsMoved);
    expect(dry.hashesUnkept).toBe(done.hashesUnkept);
    expect(dry.replaced).toEqual(done.replaced);
  });

  it('seals a note as it is when its transaction runs, not as the page found it', async () => {
    sealingOn();
    store.set(notePath('n1'), note('First words'));
    const db = fakeDb(store);
    // Another device writes between the page read and the transaction.
    const run = db.runTransaction.bind(db);
    let once = true;
    (db as { runTransaction: typeof run }).runTransaction = ((fn: Parameters<typeof run>[0]) => {
      if (once) {
        once = false;
        store.set(notePath('n1'), note('Newer words from the laptop', { deviceId: 'laptop' }));
      }
      return run(fn);
    }) as typeof run;
    await sealAllPass({ ...deps(), db, codec: new NoteCodec(UID, keyFor, sealingIn(db, UID)) });
    const n1 = store.get(notePath('n1'))!;
    expect(open('n1', 'body', n1['body'])).toBe('Newer words from the laptop');
    expect(n1['deviceId']).toBe('laptop');
  });

  it('leaves a note it cannot open as stored, and counts it', async () => {
    sealingOn();
    const other = newDataKey();
    const locked = note(seal('n1', 'body', 'Sealed elsewhere', other), { title: 'Plain title' });
    store.set(notePath('n1'), copy(locked) as Data);
    const report = await passAll();
    expect(store.get(notePath('n1'))).toEqual(locked);
    expect(report.left.notes).toEqual({ 'cannot-open': 1 });
    expect(report.sealed.notes).toBe(0);
  });

  it('leaves only a recipe import asked for minutes ago; seals what is stuck or safe at any age', async () => {
    sealingOn();
    const fresh = ts(T - 60_000);
    const stale = ts(T - IMPORT_FRESH_MS - 1);
    store.set(
      notePath('r1'),
      note('Jam', { kind: 'recipe', importState: 'requested', updatedAt: fresh }),
    );
    store.set(
      notePath('r2'),
      note('Chutney', { kind: 'recipe', importState: 'requested', updatedAt: stale }),
    );
    store.set(
      notePath('r3'),
      note('Pickle', { kind: 'recipe', importState: 'working', updatedAt: fresh }),
    );
    // A run going, and one left going by a lost function.
    store.set(`${base}/runs/live`, {
      kind: 'queued-note',
      noteId: 'r1',
      status: 'working',
      outcome: 'partly',
      startedAt: ts(T - 1000),
      steps: [],
    });
    const plainRun = itemRunId(
      'i1',
      itemHash('i1', ITEM_TEXT, 'plain', () => undefined)!,
    );
    store.set(`${base}/runs/${plainRun}`, {
      kind: 'item',
      noteId: 'i1',
      itemText: ITEM_TEXT,
      itemKey: ITEM_TEXT,
      status: 'requested',
      attempt: 1,
      createdAt: ts(T - RUN_STALE_MS - 1),
      steps: [],
    });
    // Suggestions accepted, and stuck applying.
    store.set(`${base}/proposals/p1`, {
      kind: 'link',
      reason: 'Jam links',
      notes: [{ id: 'r1', title: 'Jam' }],
      key: 'link:r1>x',
      status: 'accepted',
    });
    store.set(`${base}/proposals/p2`, {
      kind: 'merge',
      reason: 'Jam and chutney',
      notes: [
        { id: 'r1', title: 'Jam' },
        { id: 'r2', title: 'Chutney' },
      ],
      key: 'merge:r1,r2',
      status: 'applying',
      claimedAt: ts(T - 86_400_000),
    });
    const before = copy(store.get(`${base}/runs/${plainRun}`)) as Data;
    const report = await passAll();
    expect(store.get(notePath('r1'))!['body']).toBe('Jam');
    expect(isSealed(store.get(notePath('r2'))!['body'])).toBe(true);
    expect(store.get(notePath('r2'))!['importState']).toBe('requested');
    expect(isSealed(store.get(notePath('r3'))!['body'])).toBe(true);
    expect(isSealed(store.get(`${base}/runs/live`)!['outcome'])).toBe(true);
    // Sealed in place, never moved: a new document `requested` would start agentRun.
    const stuck = store.get(`${base}/runs/${plainRun}`)!;
    expect(isSealed(stuck['itemText'])).toBe(true);
    expect(runRequested(before, stuck)).toBe(false);
    expect([...store.keys()].filter((p) => p.includes('/runs/item-'))).toHaveLength(1);
    expect(isSealed(store.get(`${base}/proposals/p1`)!['reason'])).toBe(true);
    expect(store.get(`${base}/proposals/p1`)!['status']).toBe('accepted');
    expect(isSealed(store.get(`${base}/proposals/p2`)!['reason'])).toBe(true);
    expect(report.left).toMatchObject({ notes: { busy: 1 }, runs: { 'id-kept': 1 } });
    expect(report.left.suggestions).toEqual({});
  });

  it('seals an item run in place when a newer run holds its keyed id', async () => {
    sealingOn();
    store.set(notePath('i1'), note(ITEM_BODY));
    const plainRun = itemRunId(
      'i1',
      itemHash('i1', ITEM_TEXT, 'plain', () => undefined)!,
    );
    const keyedRun = itemRunId(
      'i1',
      itemHash('i1', ITEM_TEXT, 'sealed', () => key)!,
    );
    store.set(`${base}/runs/${plainRun}`, {
      kind: 'item',
      noteId: 'i1',
      itemText: ITEM_TEXT,
      itemKey: ITEM_TEXT,
      status: 'failed',
      steps: [],
    });
    store.set(`${base}/runs/${keyedRun}`, {
      kind: 'item',
      noteId: 'i1',
      status: 'done',
      steps: [],
    });
    const report = await passAll();
    const old = store.get(`${base}/runs/${plainRun}`)!;
    expect(isSealed(old['itemText'])).toBe(true);
    expect(report.left.runs).toEqual({ 'id-kept': 1 });
  });

  it('pauses at its deadline and goes on from the cursor', async () => {
    seedPlainGarden();
    let t = 0;
    const first = await sealAllPass(deps({ now: () => t++, deadline: 2 }));
    expect(first.done).toBe(false);
    expect(first.cursor?.kind).toBe('notes');
    let out = first;
    while (!out.done) out = await sealAllPass(deps(), out.cursor);
    for (const w of WORDS) expect(everything()).not.toContain(w);
  });

  it('keys a base it finds only in a replaced text, and the body hash an entry keeps', async () => {
    sealingOn();
    store.set(notePath('n1'), note('Now', { baseHash: textHash('Was') }));
    store.set(`${notePath('n1')}/replaced/${textHash('Was')}`, {
      body: 'Was',
      writtenAt: ts(T),
      expireAt: ts(T + 1000),
    });
    store.set(`${base}/activity/a1`, {
      at: ts(T),
      tool: 'refile',
      summary: 'Now: kind person',
      notes: [{ id: 'n1', title: 'Now', before: { body: textHash('Now') } }],
      reminders: [],
    });
    await passAll();
    expect(store.get(notePath('n1'))!['baseHash']).toBe(keyedBody('n1', 'Was'));
    const before = ((store.get(`${base}/activity/a1`)!['notes'] as Data[])[0]['before'] as Data)[
      'body'
    ];
    expect(before).toBe(keyedBody('n1', 'Now'));
    expect(isKeyedHash(before)).toBe(true);
  });

  it('stops when the switch is turned off mid-pass', async () => {
    seedPlainGarden();
    let reads = 0;
    const d = deps({
      stillOn: async () => reads++ < 1,
    });
    await expect(sealAllPass(d)).rejects.toBeInstanceOf(SealingTurnedOff);
  });
});

describe('relabelling a summary keeps what readers tell from it', () => {
  const cases: [string, string, number][] = [
    ['update_note', "Changed a note's text and tags", 1],
    ['update_note', 'Archived a note', 1],
    ['update_note', 'Renamed Shed to Barn and changed its text', 1],
    ['refile', 'Barn: filed under Farm', 1],
    ['refile', 'Barn: kind person', 1],
    ['merge_notes', 'Merged Shed and Barn into one', 3],
    ['put_back', 'Put back “Added 2 lines to Shed”', 1],
    ['update_note', 'Restored a note; Changed Shed text', 1],
  ];
  it.each(cases)('%s: %s', (tool, summary, n) => {
    const out = relabelSummary(tool, summary, n);
    expect(summarySaysText(out)).toBe(summarySaysText(summary));
    expect(/\bArchived a note\b/.test(out)).toBe(/\bArchived a note\b/.test(summary));
    expect(/\bRestored a note\b/.test(out)).toBe(/\bRestored a note\b/.test(summary));
    const filed = (s: string) =>
      rerouteNotes(
        { tool, summary: s, notes: [{ id: 'x', before: { parent: null } }] },
        () => false,
      );
    expect(filed(out)).toEqual(filed(summary));
    for (const w of ['Shed', 'Barn', 'Farm']) expect(out).not.toContain(w);
    // Idempotent.
    expect(relabelSummary(tool, out, n)).toBe(out);
  });

  it('hashes the names in a refile key as a new one is made, and leaves other keys', () => {
    const hash = (id: string, names: string) => `k1.${id}|${names}`;
    expect(hashedRefileKey('refile:c-x:person:a,b', hash)).toBe('refile:c-x:person:k1.c-x|a,b');
    // A name may hold a colon.
    expect(hashedRefileKey('refile:c-x::a:b,c', hash)).toBe('refile:c-x::k1.c-x|a:b,c');
    expect(hashedRefileKey('refile:c-x::', hash)).toBe('refile:c-x::');
    expect(hashedRefileKey('refile:c-x::k1.00ff', hash)).toBe('refile:c-x::k1.00ff');
    expect(hashedRefileKey('merge:a,b', hash)).toBe('merge:a,b');
  });

  it('makes the same key a new refile of the same names gets', async () => {
    sealingOn();
    const codec = new NoteCodec(UID, keyFor, sealingIn(fakeDb(store), UID));
    const names = refileNames({ synonyms: ['Marmelo', 'Bael'] });
    const fresh = `refile:c-quince:other:${(await codec.namesHasher())('c-quince', names)}`;
    expect(
      hashedRefileKey(
        keyOf({
          kind: 'refile',
          id: 'c-quince',
          type: 'other',
          synonyms: ['Marmelo', 'Bael'],
          reason: 'r',
        }),
        await codec.namesHasher(),
      ),
    ).toBe(fresh);
  });
});

describe('the callable', () => {
  it('refuses with the switch off, and seals nothing', async () => {
    store.set(notePath('n1'), note('Plain words'));
    await expect(
      sealEverythingFor(
        fakeDb(store),
        UID,
        { dryRun: false },
        0,
        keyFor,
        undefined,
        undefined,
        keyFor,
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(store.get(notePath('n1'))!['body']).toBe('Plain words');
  });

  it('refuses when the key cannot be fetched, and seals nothing', async () => {
    sealingOn();
    store.set(notePath('n1'), note('Plain words'));
    const none = vi.fn(async () => {
      throw new NoteKeysUnconfigured('no domain');
    });
    const refused = sealEverythingFor(
      fakeDb(store),
      UID,
      { dryRun: false },
      0,
      keyFor,
      undefined,
      undefined,
      none,
    );
    await expect(refused).rejects.toBeInstanceOf(SealAllRefused);
    await expect(refused).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(store.get(notePath('n1'))!['body']).toBe('Plain words');
  });

  it('seals only the caller’s garden', async () => {
    sealingOn();
    store.set(notePath('n1'), note('Mine'));
    store.set(notePath('n1', OTHER), note('Theirs'));
    store.set(`users/${OTHER}/settings/assistant`, { sealNotes: true });
    const fresh = vi.fn(async (_uid: string) => key);
    const kept = vi.fn(async (_uid: string) => key);
    const pass = await sealEverythingFor(
      fakeDb(store),
      UID,
      { dryRun: false },
      Date.now(),
      kept,
      undefined,
      undefined,
      fresh,
    );
    expect(pass.done).toBe(true);
    // The check asks afresh, once; the pass uses the kept key, asked once.
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(kept).toHaveBeenCalledTimes(1);
    expect([...fresh.mock.calls, ...kept.mock.calls].every(([u]) => u === UID)).toBe(true);
    expect(isSealed(store.get(notePath('n1'))!['body'])).toBe(true);
    expect(store.get(notePath('n1', OTHER))!['body']).toBe('Theirs');
  });

  it('answers a cursor when it runs out of time', async () => {
    seedPlainGarden();
    let t = 0;
    const pass = await sealEverythingFor(
      fakeDb(store),
      UID,
      { dryRun: true },
      0,
      keyFor,
      1,
      () => t++,
      keyFor,
    );
    expect(pass.done).toBe(false);
    expect(pass.cursor).toBeDefined();
  });

  it('reads only a request of the right shape', () => {
    expect(sealRequestOf({ dryRun: true })).toEqual({ dryRun: true });
    expect(sealRequestOf({ dryRun: false, cursor: { kind: 'runs', after: 'x' } })).toEqual({
      dryRun: false,
      cursor: { kind: 'runs', after: 'x' },
    });
    expect(() => sealRequestOf({})).toThrow(SealAllRefused);
    expect(() => sealRequestOf({ dryRun: true, cursor: { kind: 'users' } })).toThrow(
      SealAllRefused,
    );
  });
});

// ---- The triggers do not react to a write that changes only the form ----

/** The write the pass makes to note `id`: before as stored, after it, and the store with it. */
async function migrated(id: string, data: Data) {
  sealingOn();
  store.set(notePath(id), copy(data) as Data);
  const before = snapAt(store, notePath(id));
  const db = fakeDb(store);
  const unit = await sealNote(db, new NoteCodec(UID, keyFor, sealingIn(db, UID)), UID, id, false);
  expect(unit.result).toBe('sealed');
  return { before, after: snapAt(store, notePath(id)), db };
}

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() });

describe('the triggers take a form-only write for nothing', () => {
  const ITEM = note(`Pottery\n- [ ] ${ITEM_TEXT} @goblin`, { baseHash: textHash('Pottery') });

  it('noteHistory keeps no version, remembers nothing and merges nothing', async () => {
    const { before, after, db } = await migrated('i1', ITEM);
    const was = JSON.stringify([...store]);
    const out = await historyOnWrite(
      db,
      new NoteCodec(UID, keyFor, sealingIn(db, UID)),
      UID,
      'i1',
      'e1',
      before,
      after,
      T,
      log(),
    );
    expect(out).toEqual({ kept: null, merged: 'clean' });
    expect(JSON.stringify([...store])).toBe(was);
  });

  it('noteHistory without the key keeps nothing as stored either', async () => {
    const { before, after, db } = await migrated('i1', ITEM);
    const was = JSON.stringify([...store]);
    const none = vi.fn(async () => {
      throw new NoteKeysUnconfigured('no key');
    });
    const out = await historyOnWrite(
      db,
      new NoteCodec(UID, none, sealingIn(db, UID)),
      UID,
      'i1',
      'e1',
      before,
      after,
      T,
      log(),
    );
    expect(out).toMatchObject({ kept: null, merged: 'none', sealed: true });
    expect(JSON.stringify([...store])).toBe(was);
  });

  it('noteHistory over a later migration of a sealed body (only other fields) opens nothing', async () => {
    const data = note(seal('n2', 'body', 'Sealed body'), {
      title: seal('n2', 'title', 'Sealed body'),
      instructions: 'still plain',
    });
    const { before, after, db } = await migrated('n2', data);
    const opener = vi.fn(async (_uid: string) => key);
    const out = await historyOnWrite(
      db,
      new NoteCodec(UID, opener, sealingIn(db, UID)),
      UID,
      'n2',
      'e1',
      before,
      after,
      T,
      log(),
    );
    expect(out).toEqual({ kept: null, merged: 'none' });
    expect(opener).not.toHaveBeenCalled();
  });

  it('noteTitle, itemAssigned and noteArrived start nothing', async () => {
    const { before, after, db } = await migrated('i1', ITEM);
    const was = JSON.stringify([...store]);
    const codec = () => new NoteCodec(UID, keyFor, sealingIn(db, UID));
    const titler = vi.fn(async () => 'A title');
    expect(await titleOnWrite(db, codec(), titler, UID, 'i1', before, after, log())).toBe(
      'skipped',
    );
    expect(titler).not.toHaveBeenCalled();
    expect(
      await assignedOnWrite(db, codec(), UID, 'i1', before.data(), after.data(), T, log()),
    ).toBe(0);
    expect(await gardenOnArrival(db, UID, 'i1', before.data(), after.data(), codec())).toBe(
      'not-arrival',
    );
    expect(JSON.stringify([...store])).toBe(was);
  });

  it('noteArrived starts nothing for a note never settled either', async () => {
    const { before, after, db } = await migrated(
      'n3',
      note('Fresh words', { settledAt: undefined }),
    );
    expect(
      await gardenOnArrival(
        db,
        UID,
        'n3',
        before.data(),
        after.data(),
        new NoteCodec(UID, keyFor, sealingIn(db, UID)),
      ),
    ).toBe('not-arrival');
  });

  it('a moved item run is not started again at the next settle', async () => {
    const { plainRun } = seedPlainGarden();
    await passAll();
    expect(store.has(`${base}/runs/${plainRun}`)).toBe(false);
    // The item unticked and the note settled again.
    const db = fakeDb(store);
    const was = copy(store.get(notePath('i1'))) as Data;
    const now = {
      ...was,
      body: seal('i1', 'body', `Pottery\n- [ ] ${ITEM_TEXT} @goblin`),
      settledAt: ts(T + 5000),
    };
    store.set(notePath('i1'), now);
    expect(assignedItems(`Pottery\n- [ ] ${ITEM_TEXT} @goblin`)[0].key).toBe(ITEM_TEXT);
    const started = await assignedOnWrite(
      db,
      new NoteCodec(UID, keyFor, sealingIn(db, UID)),
      UID,
      'i1',
      was,
      now,
      T,
      log(),
    );
    expect(started).toBe(0);
  });

  it('agentRun takes a sealed or moved finished run for no request', () => {
    const done = { status: 'done', attempt: 1 };
    expect(runRequested(done, { ...done })).toBe(false);
    expect(runRequested(undefined, done)).toBe(false);
    expect(runRequested(done, undefined)).toBe(false);
  });
});

// ---- A device offline through the pass writes later ----

describe('a device that was offline through the pass', () => {
  it('writes over the text it saw: matched by its plain base, nothing merged or lost', async () => {
    const t0 = 'Seed list\nbeans';
    const { after: migratedSnap, db } = await migrated('n1', note(t0));
    // The laptop, offline since before, saves on the plain text it had.
    const stale = note(`${t0}\npeas`, { deviceId: 'laptop', baseHash: textHash(t0) });
    store.set(notePath('n1'), stale);
    const out = await historyOnWrite(
      db,
      new NoteCodec(UID, keyFor, sealingIn(db, UID)),
      UID,
      'n1',
      'e2',
      migratedSnap,
      snapAt(store, notePath('n1')),
      T,
      log(),
    );
    expect(out.merged).toBe('clean');
    // The sealed text it replaced is kept in History, sealed.
    const kept = store.get(`${notePath('n1')}/history/e2`)!;
    expect(open('n1', 'body', kept['body'])).toBe(t0);
    // Its own words stand, plain until it hears the switch: the next
    // dry run counts the note again.
    expect(store.get(notePath('n1'))!['body']).toBe(`${t0}\npeas`);
    const dry = await passAll(true);
    expect(dry.sealed.notes).toBe(1);
  });

  it('merges with text written since, finding its base in sealed History', async () => {
    const t0 = 'Seed list\nbeans';
    const t1 = 'Seed list\nbeans\nleeks (Claude)';
    store.set(`${notePath('n1')}/history/v0`, {
      body: t0,
      title: 'Seed list',
      updatedBy: 'user',
      deviceId: 'phone',
      updatedAt: ts(T - 90_000),
      savedAt: ts(T - 80_000),
      reason: 'author',
    });
    const { db } = await migrated(
      'n1',
      note(t1, { updatedBy: 'claude', deviceId: 'mcp', baseHash: textHash(t0) }),
    );
    await passAll();
    expect(isSealed(store.get(`${notePath('n1')}/history/v0`)!['body'])).toBe(true);
    const before = snapAt(store, notePath('n1'));
    // The laptop's save, typed over t0 while offline.
    store.set(
      notePath('n1'),
      note('Seed list\npeas\nbeans', { deviceId: 'laptop', baseHash: textHash(t0) }),
    );
    const out = await historyOnWrite(
      db,
      new NoteCodec(UID, keyFor, sealingIn(db, UID)),
      UID,
      'n1',
      'e3',
      before,
      snapAt(store, notePath('n1')),
      T,
      log(),
    );
    expect(out.merged).toBe('merged');
    const merged = store.get(notePath('n1'))!;
    expect(isSealed(merged['body'])).toBe(true);
    const text = open('n1', 'body', merged['body']);
    expect(text).toContain('peas');
    expect(text).toContain('leeks (Claude)');
    expect(isKeyedHash(merged['baseHash'])).toBe(true);
  });

  it('keeps every line of both when its base is kept nowhere any more', async () => {
    const { after: migratedSnap, db } = await migrated(
      'n1',
      note('Seed list\nleeks', { updatedBy: 'claude', deviceId: 'mcp' }),
    );
    store.set(
      notePath('n1'),
      note('Seed list\npeas', { deviceId: 'laptop', baseHash: textHash('Seed list\nlong gone') }),
    );
    const out = await historyOnWrite(
      db,
      new NoteCodec(UID, keyFor, sealingIn(db, UID)),
      UID,
      'n1',
      'e4',
      migratedSnap,
      snapAt(store, notePath('n1')),
      T,
      log(),
    );
    expect(out.merged).toBe('kept-both');
    const text = open('n1', 'body', store.get(notePath('n1'))!['body']);
    expect(text).toContain('peas');
    expect(text).toContain('leeks');
  });
});

// ---- Put back still works on entries the pass relabelled ----

describe('put back after the pass', () => {
  const tools = () => new NotesTools(fakeDb(store), UID, () => T, undefined, undefined, keyFor);
  const runOf = (tool: string) =>
    [...store.entries()]
      .find(([p, d]) => p.startsWith(`${base}/activity/`) && d['tool'] === tool)![0]
      .split('/')
      .pop()!;

  beforeEach(() => {
    store.set(`${base}/settings/modules`, { projects: { enabled: true } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('puts the other names back on a refile recorded before the pass', async () => {
    store.set(
      notePath('c-moss'),
      note('', { kind: 'concept', title: 'Moss', titleSource: 'user', synonyms: ['Mossy'] }),
    );
    await tools().refile({ id: 'c-moss', addSynonyms: ['Lichen-ish'] });
    const runId = runOf('refile');
    sealingOn();
    await passAll();
    const entry = store.get(`${base}/activity/${runId}`)!;
    expect(JSON.stringify(entry)).not.toContain('Moss');
    expect(await putBack(fakeDb(store), UID, runId, T + 60_000, undefined, keyFor)).toMatchObject({
      status: 'done',
    });
    const names = store.get(notePath('c-moss'))!['synonyms'] as string[];
    expect(names.map((n) => open('c-moss', 'synonyms', n))).toEqual(['Mossy']);
  });

  it('puts back text a run wrote before the pass, its base found by its keyed hash', async () => {
    store.set(notePath('n1'), note('Seed list\nbeans'));
    await tools().addLines({ id: 'n1', lines: ['- leeks'] });
    // What noteHistory kept of the text the run replaced.
    store.set(`${notePath('n1')}/history/v0`, {
      body: 'Seed list\nbeans',
      title: 'Seed list',
      updatedBy: 'user',
      deviceId: 'phone',
      updatedAt: ts(T - 60_000),
      savedAt: ts(T),
      reason: 'author',
    });
    const runId = runOf('add_lines');
    sealingOn();
    await passAll();
    expect(isKeyedHash(store.get(notePath('n1'))!['baseHash'])).toBe(true);
    expect(everything()).not.toContain('beans');
    expect(await putBack(fakeDb(store), UID, runId, T + 60_000, undefined, keyFor)).toMatchObject({
      status: 'done',
    });
    expect(open('n1', 'body', store.get(notePath('n1'))!['body'])).toBe('Seed list\nbeans');
  });

  it('puts back a run written over another of Claude’s, its text only in a replaced text', async () => {
    // Claude wrote the note last, so no History version is kept between
    // its runs: the text before is only in the replaced text noteHistory
    // keeps, under the plain id it had before the pass.
    store.set(notePath('n1'), note('Seed list\nbeans', { updatedBy: 'claude', deviceId: 'mcp' }));
    await tools().addLines({ id: 'n1', lines: ['- leeks'] });
    store.set(`${notePath('n1')}/replaced/${textHash('Seed list\nbeans')}`, {
      body: 'Seed list\nbeans',
      writtenAt: ts(T),
      expireAt: ts(T + 86_400_000),
    });
    const runId = runOf('add_lines');
    sealingOn();
    await passAll();
    expect(store.get(notePath('n1'))!['baseHash']).toBe(keyedBody('n1', 'Seed list\nbeans'));
    expect(await putBack(fakeDb(store), UID, runId, T + 60_000, undefined, keyFor)).toMatchObject({
      status: 'done',
    });
    expect(open('n1', 'body', store.get(notePath('n1'))!['body'])).toBe('Seed list\nbeans');
  });
});

// ---- One document that goes wrong never stops the rest (review on #277) ----

/** A Firestore whose transactions fail, as `fail` says, when they read `path`. */
function failingAt(path: string, fail: () => unknown) {
  const db = fakeDb(store);
  const run = db.runTransaction.bind(db);
  (db as { runTransaction: typeof run }).runTransaction = ((fn: Parameters<typeof run>[0]) =>
    run(async (tx) => {
      const get = tx.get.bind(tx);
      (tx as { get: typeof get }).get = ((target: Parameters<typeof get>[0]) => {
        if ((target as { path?: string }).path === path) throw fail();
        return get(target);
      }) as typeof get;
      return fn(tx);
    })) as typeof run;
  return db;
}

class BoomError extends Error {
  override readonly name = 'BoomError';
}

describe('a document that goes wrong', () => {
  const garden = () => {
    seedPlainGarden();
    store.set(notePath('n2'), note('Bad apple words'));
  };
  const passWith = async (db: ReturnType<typeof fakeDb>, log = vi.fn()) =>
    passAll(false, { db, codec: new NoteCodec(UID, keyFor, sealingIn(db, UID)), log });

  it.each([
    ['failed', () => new BoomError('secret words never shown'), { BoomError: 1 }],
    ['contended', () => Object.assign(new Error('10 ABORTED: contention'), { code: 10 }), {}],
  ] as const)(
    'is left as stored, counted %s, and the rest are sealed',
    async (reason, fail, failures) => {
      garden();
      const log = vi.fn();
      const report = await passWith(failingAt(notePath('n2'), fail), log);
      expect(store.get(notePath('n2'))!['body']).toBe('Bad apple words');
      expect(report.left.notes).toEqual({ [reason]: 1 });
      expect(report.failures).toEqual(failures);
      // Everything after it, in every kind, is sealed.
      for (const w of WORDS) expect(everything(), w).not.toContain(w);
      expect(report.sealed).toEqual({
        notes: 5,
        versions: 1,
        suggestions: 2,
        runs: 2,
        activity: 3,
      });
      // Said by its place and reason, never its text or the error's message.
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(log.mock.calls)).toContain('notes/n2');
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/Bad apple|secret words/);
      // A rerun meets it again, and skips nothing else.
      const again = await passWith(failingAt(notePath('n2'), fail));
      expect(again.left.notes).toEqual({ [reason]: 1 });
      expect(again.sealed).toEqual({ notes: 0, versions: 0, suggestions: 0, runs: 0, activity: 0 });
    },
  );

  it('goes on past a suggestion, a run and an entry that fail', async () => {
    garden();
    const db = failingAt(`${base}/activity/a1`, () => new BoomError('x'));
    const report = await passWith(db);
    expect(report.left.activity).toEqual({ failed: 1 });
    expect(store.get(`${base}/activity/a1`)!['summary']).toBe('Added 1 line to Shed roof leaks');
    expect(store.get(`${base}/activity/a2`)!['summary']).not.toContain('Orchard');
  });

  it('says a note too large to seal, without sealing it, and still seals its History', async () => {
    sealingOn();
    // About 790 kB of text: sealed, past Firestore's 1 MiB.
    const long = 'a'.repeat(790_000);
    store.set(notePath('big'), note(long));
    store.set(`${notePath('big')}/history/v1`, {
      body: 'short older words',
      title: 'short',
      updatedBy: 'user',
      deviceId: 'phone',
      savedAt: ts(T),
      reason: 'device',
    });
    store.set(`${notePath('big')}/history/v2`, {
      body: long,
      title: 'long',
      updatedBy: 'user',
      deviceId: 'phone',
      savedAt: ts(T),
      reason: 'device',
    });
    store.set(notePath('small'), note('Small words'));
    const dry = await passAll(true);
    expect(dry.left.notes).toEqual({ 'too-large': 1 });
    expect(dry.left.versions).toEqual({ 'too-large': 1 });
    const report = await passAll();
    expect(report.left.notes).toEqual({ 'too-large': 1 });
    expect(report.left.versions).toEqual({ 'too-large': 1 });
    expect(store.get(notePath('big'))!['body']).toBe(long);
    expect(isSealed(store.get(`${notePath('big')}/history/v1`)!['body'])).toBe(true);
    expect(isSealed(store.get(notePath('small'))!['body'])).toBe(true);
  });

  it('seals a note just under the limit', async () => {
    sealingOn();
    const n = Math.floor(((MAX_DOC_BYTES - 4_000) * 3) / 4) - 200;
    store.set(notePath('big'), note('b'.repeat(n), { title: 'Big' }));
    const report = await passAll();
    expect(report.left.notes).toEqual({});
    expect(isSealed(store.get(notePath('big'))!['body'])).toBe(true);
  });
});

describe('the digest after a relabel', () => {
  it('still counts the lines an old add_lines added', () => {
    const at = T;
    const record = (summary: string, title: string) => ({
      at,
      tool: 'add_lines',
      summary,
      notes: [{ id: 'n1', title }],
    });
    const window = { from: T - 1, to: T + 1 };
    const before = digestSentence([record('Added 3 lines to Kiln log', 'Kiln log')], window)!;
    const after = digestSentence(
      [record(relabelSummary('add_lines', 'Added 3 lines to Kiln log', 1), 'Sealed note')],
      window,
    )!;
    expect(before).toContain('3 lines');
    expect(after).toContain('3 lines');
    expect(after).not.toContain('Kiln');
  });

  it('still counts an update_note as an edit, and a filing as one', () => {
    const window = { from: T - 1, to: T + 1 };
    const out = (tool: string, summary: string) =>
      digestSentence(
        [{ at: T, tool, summary, notes: [{ id: 'n1', title: 'Sealed note' }] }],
        window,
      );
    for (const [tool, summary] of [
      ['update_note', "Archived a note; Changed a note's text about Barn"],
      ['refile', 'Barn: filed under Farm'],
    ] as const) {
      const relabelled = relabelSummary(tool, summary, 1);
      expect(out(tool, relabelled)?.replace(/Farm|Barn/g, '')).toBeDefined();
      expect(relabelled).not.toMatch(/Barn|Farm/);
      expect(/\bChanged a note's\b/.test(relabelled)).toBe(/\bChanged a note's\b/.test(summary));
      expect(/\bfiled under\b/.test(relabelled)).toBe(/\bfiled under\b/.test(summary));
    }
  });
});

describe('a cursor', () => {
  it('that is not one a pass gave is refused, plainly', () => {
    for (const after of ['a/b', '.', '..', '', 'x'.repeat(1501), 7]) {
      expect(() => sealRequestOf({ dryRun: true, cursor: { kind: 'notes', after } })).toThrow(
        /not one this pass gave/,
      );
    }
  });
});
