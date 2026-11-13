import { type DataKey, aadFor, newDataKey, sealText } from '@mossgoblin/schema';
import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SealedNoteError } from '../mcp/note-text';
import { NoteKeysUnconfigured } from '../note-keys/client';
import { type Store, fakeDb } from '../testing/fake-firestore';
import { firestoreRunStore } from './firestore-store';

// Note encryption step 3d (2026-11-13): a queued note's run is briefed
// with Eric's ask, so agentRun's note state opens a sealed ask; one it
// cannot open fails the run, saying the note is sealed, rather than
// running it without the ask. Over the in-memory Firestore.

const UID = 'u1';
const ID = 'n1';
const T = Date.parse('2026-11-13T10:00:00Z');

let store: Store;
let key: DataKey;
let keyFor: ReturnType<typeof vi.fn<(uid: string) => Promise<DataKey>>>;

const state = () => firestoreRunStore(fakeDb(store), keyFor).noteState(UID, ID);

function put(sendAsk: string, title = 'Plans') {
  store.set(`users/${UID}/notes/${ID}`, {
    kind: 'text',
    body: 'Plans',
    title,
    sendState: 'queued',
    sendAsk,
    sentAt: Timestamp.fromMillis(T),
  });
}

beforeEach(() => {
  store = new Map();
  key = newDataKey();
  keyFor = vi.fn(async () => key);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('agentRun note state', () => {
  it('opens a sealed ask for the brief, and leaves a sealed title unsaid', async () => {
    put(
      sealText(key, aadFor(UID, ID, 'sendAsk'), 'Pack for the trip'),
      sealText(key, aadFor(UID, ID, 'title'), 'Trip'),
    );
    expect(await state()).toMatchObject({
      title: 'Sealed note',
      sendState: 'queued',
      sendAsk: 'Pack for the trip',
    });
  });

  it('a plain ask as before, asking for no key', async () => {
    put('Pack for the trip');
    expect((await state())?.sendAsk).toBe('Pack for the trip');
    expect(keyFor).not.toHaveBeenCalled();
  });

  it('a sealed ask that cannot be opened here throws, naming no text', async () => {
    keyFor.mockImplementation(async () => {
      throw new NoteKeysUnconfigured('no note keys here');
    });
    put(sealText(key, aadFor(UID, ID, 'sendAsk'), 'Pack for the trip'));
    const err = await state().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SealedNoteError);
    expect((err as Error).message).not.toContain('Pack');
  });
});
