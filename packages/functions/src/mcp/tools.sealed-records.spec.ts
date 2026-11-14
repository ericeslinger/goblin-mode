import {
  type DataKey,
  SEAL_SENTINEL,
  aadFor,
  isSealed,
  newDataKey,
  openText,
  paths,
  recordAadFor,
  sealText,
} from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteKeysUnconfigured } from '../note-keys/client';
import { applyAccepted } from '../organize/apply';
import { type Data, type Store, fakeDb } from '../testing/fake-firestore';
import { NoteCodec } from './note-text';
import { NotesTools } from './tools';

// Note encryption step 3e (2026-11-13): text about notes stored outside
// them. A suggestion about a sealed note names it "Sealed note" and
// stores its proposed title and reason sealed under its own id; what
// assistants changed names a note "Sealed note" when any of its fields
// is sealed, a plain title beside a sealed body included. With plain
// notes nothing changes and no key is asked for.

const UID = 'u1';
const T = Date.parse('2026-11-13T10:00:00Z');

let store: Store;
let key: DataKey;
let keyFor: ReturnType<typeof vi.fn<(uid: string) => Promise<DataKey>>>;

const notePath = (id: string) => `users/${UID}/notes/${id}`;
const seal = (id: string, field: 'body' | 'title', text: string) =>
  sealText(key, aadFor(UID, id, field), text);
const docsIn = (path: string) =>
  [...store.entries()]
    .filter(([p]) => p.startsWith(`${path}/`))
    .map(([p, d]) => ({
      id: p.split('/').pop()!,
      d,
    }));
const proposals = () => docsIn(paths.proposals(UID));
const activity = () => docsIn(paths.activity(UID)).map((x) => x.d);
const openProposal = (id: string, field: 'title' | 'reason', value: unknown) =>
  openText(key, recordAadFor(UID, 'proposals', id, field), String(value));

function put(id: string, body: string, over: Data = {}) {
  store.set(notePath(id), {
    kind: 'text',
    body,
    title: body.split('\n')[0],
    titleSource: 'words',
    links: [],
    tags: [],
    archived: false,
    createdAt: Timestamp.fromMillis(T - 60_000),
    updatedAt: Timestamp.fromMillis(T - 60_000),
    updatedBy: 'user',
    deviceId: 'phone',
    ...over,
  });
}
/** A note with its body sealed and its title left plain, unless `title` says. */
const putSealedBody = (id: string, body: string, over: Data = {}) =>
  put(id, seal(id, 'body', body), { title: body.split('\n')[0], ...over });

const tools = () => new NotesTools(fakeDb(store), UID, () => T, undefined, undefined, keyFor);

beforeEach(() => {
  store = new Map();
  store.set(`users/${UID}/settings/modules`, { projects: { enabled: true } });
  key = newDataKey();
  keyFor = vi.fn(async () => key);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('suggest_changes, plain notes', () => {
  it('stores the title and reason plain, as before, with no key', async () => {
    put('a', 'Kiln log');
    put('b', 'Firing notes');
    await tools().suggestChanges({
      proposals: [{ kind: 'merge', ids: ['a', 'b'], title: 'Kiln', reason: 'Same firing' }],
    });
    const [{ d }] = proposals();
    expect(d).toMatchObject({ title: 'Kiln', reason: 'Same firing' });
    expect(d['notes']).toEqual([
      { id: 'a', title: 'Kiln log' },
      { id: 'b', title: 'Firing notes' },
    ]);
    expect(keyFor).not.toHaveBeenCalled();
  });
});

describe('suggest_changes, a sealed note', () => {
  it('seals the proposed title and reason under the suggestion, and names the notes', async () => {
    put('a', 'Kiln log');
    // A plain title beside a sealed body: the note is sealed all the same.
    putSealedBody('b', 'Firing notes\ncone 6');
    const out = await tools().suggestChanges({
      proposals: [
        {
          kind: 'merge',
          ids: ['a', 'b'],
          title: 'Kiln and firing',
          reason: 'Firing notes, cone 6',
        },
      ],
    });
    const [{ id, d }] = proposals();
    expect(isSealed(d['title'])).toBe(true);
    expect(isSealed(d['reason'])).toBe(true);
    expect(openProposal(id, 'title', d['title'])).toBe('Kiln and firing');
    expect(openProposal(id, 'reason', d['reason'])).toBe('Firing notes, cone 6');
    expect(d['notes']).toEqual([
      { id: 'a', title: 'Kiln log' },
      { id: 'b', title: 'Sealed note' },
    ]);
    expect(d['key']).toBe('merge:a,b');
    expect(JSON.stringify(d)).not.toMatch(/Firing|cone|Kiln and/);
    // The model is answered with what it wrote, opened, and no ciphertext.
    expect(out.stored[0].reason).toBe('Firing notes, cone 6');
    expect(JSON.stringify(out)).not.toContain(SEAL_SENTINEL);
    // Bound to the suggestion and the field: neither opens as the other.
    expect(() => openProposal(id, 'reason', d['title'])).toThrow();
    expect(() => openText(key, aadFor(UID, 'b', 'title'), String(d['title']))).toThrow();
  });

  it("leaves out a sealed concept's proposed names, from the suggestion and its key", async () => {
    put('k', seal('k', 'body', ''), {
      kind: 'concept',
      title: 'Kiln',
      titleSource: 'user',
      synonyms: ['Oven'],
    });
    await tools().suggestChanges({
      proposals: [
        { kind: 'refile', id: 'k', type: 'project', synonyms: ['Firebox'], reason: 'You fire it' },
      ],
    });
    const [{ d }] = proposals();
    expect(d['synonyms']).toBeUndefined();
    expect(d['key']).toBe('refile:k:project:');
    expect(JSON.stringify(d)).not.toMatch(/Firebox|Kiln/);
  });
});

describe('what assistants changed, a plain title beside a sealed body', () => {
  it('names the note "Sealed note", and its summary "a sealed note"', async () => {
    putSealedBody('a', 'Plans\nthe thing');
    await tools().archiveNote({ id: 'a' });
    const [entry] = activity();
    expect(entry['notes']).toEqual([{ id: 'a', title: 'Sealed note' }]);
    expect(JSON.stringify(entry)).not.toContain('Plans');
  });

  it("says no sealed concept's added names, nor its title, in a refile", async () => {
    put('k', seal('k', 'body', ''), { kind: 'concept', title: 'Kiln', titleSource: 'user' });
    await tools().refile({ id: 'k', addSynonyms: ['Firebox'] });
    const [entry] = activity();
    expect(entry['summary']).toBe('Refiled a sealed note: added another name');
    expect(JSON.stringify(entry)).not.toMatch(/Kiln|Firebox/);
  });

  it("does not quote a sealed project's plain title when filing under it", async () => {
    put('p', seal('p', 'body', ''), { kind: 'concept', conceptType: 'project', title: 'Pottery' });
    put('n', 'Glaze', { kind: 'concept', conceptType: 'project', titleSource: 'user' });
    await tools().refile({ id: 'n', parent: 'p' });
    const [entry] = activity();
    expect(JSON.stringify(entry)).not.toContain('Pottery');
    expect(entry['summary']).toBe('Refiled Glaze: filed under p');
  });
});

describe('proposalAccepted, a sealed suggestion', () => {
  async function proposeMerge() {
    put('a', 'Kiln log');
    putSealedBody('b', 'Firing notes');
    await tools().suggestChanges({
      proposals: [{ kind: 'merge', ids: ['a', 'b'], title: 'Kiln and firing', reason: 'Same' }],
    });
    const [{ id, d }] = proposals();
    store.set(`${paths.proposals(UID)}/${id}`, { ...d, status: 'accepted' });
    return id;
  }
  const accept = (id: string) =>
    applyAccepted(fakeDb(store), UID, id, tools(), T, new NoteCodec(UID, keyFor));

  it('opens the proposed title and merges under it, the outcome naming no sealed text', async () => {
    const id = await proposeMerge();
    expect(await accept(id)).toBe('applied');
    const p = store.get(`${paths.proposals(UID)}/${id}`)!;
    expect(p['outcome']).toBe('Merged into Sealed note');
    const merged = docsIn(paths.notes(UID)).find(
      (x) => x.d['mergedInto'] === undefined && x.id !== 'a' && x.id !== 'b',
    )!;
    expect(openText(key, aadFor(UID, merged.id, 'title'), String(merged.d['title']))).toBe(
      'Kiln and firing',
    );
  });

  it('a title sealed for another suggestion does not open: failed, saying sealed, nothing merged', async () => {
    const id = await proposeMerge();
    const path = `${paths.proposals(UID)}/${id}`;
    const moved = sealText(key, recordAadFor(UID, 'proposals', 'other', 'title'), 'Elsewhere');
    store.set(path, { ...store.get(path)!, title: moved });
    const notes = docsIn(paths.notes(UID)).length;
    expect(await accept(id)).toBe('failed');
    const p = store.get(path)!;
    expect(String(p['outcome'])).toContain('sealed');
    expect(String(p['outcome'])).not.toContain(SEAL_SENTINEL);
    expect(docsIn(paths.notes(UID)).length).toBe(notes);
  });

  it('without the key: failed, saying sealed, nothing merged', async () => {
    const id = await proposeMerge();
    keyFor.mockImplementation(async () => {
      throw new NoteKeysUnconfigured('no note keys here');
    });
    expect(await accept(id)).toBe('failed');
    expect(String(store.get(`${paths.proposals(UID)}/${id}`)!['outcome'])).toContain(
      'is sealed and cannot be opened here',
    );
  });
});
