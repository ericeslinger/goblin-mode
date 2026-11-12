import { describe, expect, it } from 'vitest';
import {
  NOTE_KEY_VERSION,
  base64ToBytes,
  bytesToBase64,
  deriveNoteKey,
  masterFromBase64,
  noteKeyFromWire,
  noteKeyInfo,
} from './note-key';

const master = new Uint8Array(32).map((_, i) => i * 7 + 1);
const other = new Uint8Array(32).map((_, i) => 255 - i);

describe('deriveNoteKey (note encryption step 2)', () => {
  it('is stable for a uid, and 32 bytes', async () => {
    const a = await deriveNoteKey(master, 'u1', NOTE_KEY_VERSION);
    const b = await deriveNoteKey(master, 'u1', NOTE_KEY_VERSION);
    expect(a.length).toBe(32);
    expect(bytesToBase64(a)).toBe(bytesToBase64(b));
  });

  it('differs across uids and masters', async () => {
    const keys = new Set(
      await Promise.all([
        deriveNoteKey(master, 'u1', 1),
        deriveNoteKey(master, 'u2', 1),
        deriveNoteKey(master, 'u10', 1),
        deriveNoteKey(other, 'u1', 1),
      ]).then((ks) => ks.map(bytesToBase64)),
    );
    expect(keys.size).toBe(4);
  });

  it('is HKDF-SHA-256 as RFC 5869 defines it, pinned so it never changes', async () => {
    // Computed with Node's own hkdfSync over the same master and info:
    // another implementation agrees, and a change to the derivation,
    // which would change every gardener's key, fails here.
    const ours = await deriveNoteKey(master, 'u1', 1);
    expect(bytesToBase64(ours)).toBe('1XqANRKXlkigXO4iMOlChH7WIdOVDiVIp7QGmzbW35k=');
  });

  it('binds the version into the info, so another version gives another key', () => {
    // Only version 1 exists; the info names it, so a version 2 cannot
    // derive the same bytes.
    const v1 = noteKeyInfo('u1', 1);
    expect(new TextDecoder().decode(v1)).toContain('v1');
    expect(() => noteKeyInfo('u1', 2)).toThrow(RangeError);
  });

  it('keeps (version, uid) pairs apart by length prefixes', () => {
    const a = bytesToBase64(noteKeyInfo('ab', 1));
    const b = bytesToBase64(noteKeyInfo('a', 1));
    expect(a).not.toBe(b);
  });

  it('refuses a short master, an empty or overlong uid', async () => {
    await expect(deriveNoteKey(new Uint8Array(16), 'u1', 1)).rejects.toThrow(RangeError);
    await expect(deriveNoteKey(master, '', 1)).rejects.toThrow(RangeError);
    await expect(deriveNoteKey(master, 'x'.repeat(129), 1)).rejects.toThrow(RangeError);
  });
});

describe('the wire form', () => {
  it('reads the master from base64, 32 bytes only', () => {
    expect(masterFromBase64(bytesToBase64(master))).toEqual(master);
    expect(masterFromBase64(` ${bytesToBase64(master)}\n`)).toEqual(master);
    expect(masterFromBase64(bytesToBase64(new Uint8Array(31)))).toBeUndefined();
    expect(masterFromBase64('not base64!')).toBeUndefined();
    expect(masterFromBase64(undefined)).toBeUndefined();
    expect(masterFromBase64('')).toBeUndefined();
  });

  it('reads a { v, key } answer, refusing anything else', () => {
    const key = bytesToBase64(master);
    expect(noteKeyFromWire({ v: 1, key })).toEqual({ v: 1, bytes: master });
    for (const bad of [
      null,
      'x',
      { v: 2, key },
      { v: '1', key },
      { v: 1 },
      { v: 1, key: bytesToBase64(new Uint8Array(16)) },
      { v: 1, key: '***' },
    ]) {
      expect(noteKeyFromWire(bad)).toBeUndefined();
    }
  });

  it('round-trips base64', () => {
    for (const n of [0, 1, 2, 3, 31, 32]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) & 255);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });
});
