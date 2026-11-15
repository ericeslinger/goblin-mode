import {
  type DataKey,
  bytesToBase64,
  exportDataKey,
  keyCheckProof,
  newDataKey,
} from '@mossgoblin/schema';
import { describe, expect, it, vi } from 'vitest';
import { KeyCheckRefused, keyCheck } from './check';
import { NoteKeyServiceError, NoteKeysUnconfigured } from './client';

// The check before sealing is switched on (2026-11-15): the functions
// fetch the gardener's key their own way and answer a proof of it for
// the app's nonce, which the app compares with its own.

const NONCE = 'AAECAwQFBgcICQoLDA0ODw';

vi.mock('firebase-functions/v2', () => ({ logger: { warn: vi.fn() } }));

describe('keyCheck', () => {
  it('answers the proof the app computes with the same key: a match', async () => {
    const key = newDataKey();
    const keyFor = vi.fn(async () => key);
    const answer = await keyCheck('u1', NONCE, keyFor);
    expect(answer).toEqual({ v: 1, proof: keyCheckProof(key, 'u1', NONCE) });
    expect(keyFor).toHaveBeenCalledWith('u1');
    // Never the key itself.
    expect(JSON.stringify(answer)).not.toContain(bytesToBase64(exportDataKey(key)));
  });

  it('answers a proof another key does not match: a mismatch the app can see', async () => {
    const server = newDataKey();
    const answer = await keyCheck('u1', NONCE, async () => server);
    expect(answer.proof).not.toBe(keyCheckProof(newDataKey(), 'u1', NONCE));
  });

  it('says plainly that the server cannot ask for keys, or that the service refused it', async () => {
    const unconfigured = async (): Promise<DataKey> => {
      throw new NoteKeysUnconfigured('APP_DOMAIN is not set');
    };
    await expect(keyCheck('u1', NONCE, unconfigured)).rejects.toMatchObject({
      name: 'KeyCheckRefused',
      code: 'failed-precondition',
      message: 'The server is not set up to ask for note keys.',
    });
    const refused = async (): Promise<DataKey> => {
      throw new NoteKeyServiceError('the note key service answered 403', 403);
    };
    await expect(keyCheck('u1', NONCE, refused)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The key service did not give the server its key (403).',
    });
    const broken = async (): Promise<DataKey> => {
      throw new Error('socket hang up');
    };
    await expect(keyCheck('u1', NONCE, broken)).rejects.toBeInstanceOf(KeyCheckRefused);
  });

  it('refuses a nonce of the wrong shape before asking for any key', async () => {
    const keyFor = vi.fn(async () => newDataKey());
    for (const nonce of [undefined, 42, 'short', `${NONCE}/+`]) {
      await expect(keyCheck('u1', nonce, keyFor)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    }
    expect(keyFor).not.toHaveBeenCalled();
  });
});

describe('the three callables (2026-11-15)', () => {
  it('run the one check as each account the note-reading functions run as', async () => {
    const { checkNoteKey, checkNoteKeyRunner, checkNoteKeyTitles } = await import('./check');
    const account = (f: unknown) =>
      (f as { __endpoint: { serviceAccountEmail?: string } }).__endpoint.serviceAccountEmail;
    // None named: the default compute account.
    expect(typeof account(checkNoteKey)).not.toBe('string');
    expect(account(checkNoteKeyTitles)).toBe('goblin-titles@');
    expect(account(checkNoteKeyRunner)).toBe('goblin-runner@');
  });
});
