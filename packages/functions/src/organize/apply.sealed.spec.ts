import { type DataKey, aadFor, newDataKey, paths, sealText } from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { NotesTools } from '../mcp/tools';
import { type Data, type Store, fakeDb } from '../testing/fake-firestore';
import { applyAccepted } from './apply';

// Note encryption step 3c (2026-11-13): the outcome proposalAccepted
// stores on a proposal quotes a sealed title as an activity entry does.

const UID = 'u1';
const T = Date.parse('2026-11-13T10:00:00Z');

let store: Store;
let key: DataKey;

function put(id: string, body: string, sealed = false) {
  const title = body.split('\n')[0];
  store.set(`users/${UID}/notes/${id}`, {
    kind: 'text',
    body: sealed ? sealText(key, aadFor(UID, id, 'body'), body) : body,
    title: sealed ? sealText(key, aadFor(UID, id, 'title'), title) : title,
    titleSource: 'words',
    links: [],
    tags: [],
    archived: false,
    createdAt: Timestamp.fromMillis(T - 60_000),
    updatedAt: Timestamp.fromMillis(T - 60_000),
    updatedBy: 'user',
    deviceId: 'phone',
  });
}

function propose(id: string, p: Data) {
  store.set(`${paths.proposals(UID)}/${id}`, { status: 'accepted', ...p });
}

async function apply(id: string) {
  const db = fakeDb(store);
  const tools = new NotesTools(
    db,
    UID,
    () => T,
    undefined,
    undefined,
    async () => key,
  );
  expect(await applyAccepted(db, UID, id, tools, T)).toBe('applied');
  return store.get(`${paths.proposals(UID)}/${id}`)!['outcome'];
}

beforeEach(() => {
  store = new Map();
  key = newDataKey();
});

describe('applyAccepted, sealed notes', () => {
  it('says a sealed title as "Sealed note" in a link or merge outcome', async () => {
    put('a', 'Plain note');
    put('b', 'Private plans', true);
    propose('p1', { kind: 'link', notes: [{ id: 'a' }, { id: 'b' }] });
    expect(await apply('p1')).toBe('Linked Sealed note');
    put('c', 'Another plain');
    propose('p2', { kind: 'merge', notes: [{ id: 'c' }, { id: 'b' }] });
    expect(await apply('p2')).toBe('Merged into Sealed note');
  });

  it('quotes plain titles as before', async () => {
    put('a', 'Plain note');
    put('b', 'Other plain');
    propose('p1', { kind: 'link', notes: [{ id: 'a' }, { id: 'b' }] });
    expect(await apply('p1')).toBe('Linked Other plain');
  });
});
