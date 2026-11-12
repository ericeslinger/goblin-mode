import { bytesToBase64, deriveNoteKey, exportDataKey, masterFromBase64 } from '@mossgoblin/schema';
import { describe, expect, it } from 'vitest';
import { noteKeys } from './client';
import { DEV_NOTE_KEYS_MASTER } from './dev-master.emulator';
import { standInNoteKeys } from './stand-in.emulator';

// The emulator build's note key stand-in (note encryption step 2): the
// Worker's derivation over the fixed development master, under the
// functions emulator only.
const EMULATOR = { FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8180' };

describe('standInNoteKeys (emulator build)', () => {
  it('derives as the Worker does, from the development master', async () => {
    const source = standInNoteKeys(EMULATOR)!;
    expect(source).toBeDefined();
    const master = masterFromBase64(DEV_NOTE_KEYS_MASTER)!;
    const key = await noteKeys(source).dataKeyFor('e2e-owner');
    expect(bytesToBase64(exportDataKey(key))).toBe(
      bytesToBase64(await deriveNoteKey(master, 'e2e-owner', 1)),
    );
    expect(bytesToBase64(await source('someone-else'))).not.toBe(bytesToBase64(exportDataKey(key)));
  });

  it('answers nothing off the emulator', () => {
    expect(standInNoteKeys({})).toBeUndefined();
    expect(standInNoteKeys({ FUNCTIONS_EMULATOR: 'true' })).toBeUndefined();
    expect(standInNoteKeys({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8180' })).toBeUndefined();
  });

  it('has a master of 32 bytes', () => {
    expect(masterFromBase64(DEV_NOTE_KEYS_MASTER)?.length).toBe(32);
  });
});
