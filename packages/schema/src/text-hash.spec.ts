import { describe, expect, it, vi } from 'vitest';
import { textHash } from './merge';
import {
  type DataKey,
  exportDataKey,
  importDataKey,
  keyedDigest,
  newDataKey,
  textHashKeyInfo,
} from './sealed';
import { PLAIN_FORMS, SEALED_FORMS } from './sealed-note';
import { toHex } from './sha256';
import { hashForm, isKeyedHash, itemHash, noteTextHash, noteTextHashMatches } from './text-hash';

// Keyed hashes (2026-11-14): a sealed note's text is stored as a hash
// only under a key derived from the gardener's data key.

const FIXED = importDataKey(Uint8Array.from({ length: 32 }, (_, i) => i));
const has = (k: DataKey) => () => k;
const none = () => undefined;
const subtle = globalThis.crypto.subtle;
const utf8 = (s: string) => new TextEncoder().encode(s);

async function webHmac(key: Uint8Array, msg: Uint8Array) {
  const k = await subtle.importKey(
    'raw',
    new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(new Uint8Array(await subtle.sign('HMAC', k, new Uint8Array(msg))));
}

/** The hash key, worked out with WebCrypto's HKDF. */
async function webHashKey(key: DataKey) {
  const ikm = await subtle.importKey('raw', exportDataKey(key), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: textHashKeyInfo() },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

/** The keyed hash worked out with WebCrypto alone, from DESIGN.md's description. */
async function webKeyed(key: DataKey, purpose: string, noteId: string, text: string, hex: number) {
  const parts = ['k1', purpose, noteId, text].map(utf8);
  const message = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(message.buffer);
  let at = 0;
  for (const p of parts) {
    view.setUint32(at, p.length);
    message.set(p, at + 4);
    at += 4 + p.length;
  }
  return `k1.${(await webHmac(await webHashKey(key), message)).slice(0, hex)}`;
}

describe('the hash key', () => {
  it('is derived by HKDF with its own info, never the data key itself', async () => {
    const key = newDataKey();
    const hashKey = await webHashKey(key);
    expect(toHex(hashKey)).not.toBe(toHex(exportDataKey(key)));
    const msg = ['k1', 'note-body', 'n1', 'hello'];
    // Not a MAC under the AES key.
    expect(toHex(keyedDigest(key, msg))).not.toBe(await webHmac(exportDataKey(key), utf8('hello')));
    expect(noteTextHash('n1', 'hello', 'sealed', has(key))).toBe(
      await webKeyed(key, 'note-body', 'n1', 'hello', 32),
    );
  });

  it('info is length-prefixed mossgoblin/text-hash and v1', () => {
    expect(toHex(textHashKeyInfo())).toBe(
      '000000146d6f7373676f626c696e2f746578742d68617368' + '000000027631',
    );
  });

  it('pins one output, so a change to the derivation is seen', async () => {
    expect(noteTextHash('n1', 'Buy milk', 'sealed', has(FIXED))).toBe(
      await webKeyed(FIXED, 'note-body', 'n1', 'Buy milk', 32),
    );
    expect(noteTextHash('n1', 'Buy milk', 'sealed', has(FIXED))).toBe(
      'k1.2faec494666398bf5a7a6040b62f42ac',
    );
  });
});

describe('noteTextHash', () => {
  it('is textHash for a plain note, byte for byte, and reads no key', () => {
    const key = vi.fn(none);
    for (const t of ['', 'Buy milk', 'Garden plan ✿\n- [ ] kale']) {
      expect(noteTextHash('n1', t, 'plain', key)).toBe(textHash(t));
    }
    expect(key).not.toHaveBeenCalled();
  });

  it('is keyed for a sealed note: its shape says so, and no plain hash is in it', () => {
    const k = newDataKey();
    const h = noteTextHash('n1', 'Buy milk', 'sealed', has(k))!;
    expect(h).toMatch(/^k1\.[0-9a-f]{32}$/);
    expect(isKeyedHash(h)).toBe(true);
    expect(isKeyedHash(textHash('Buy milk'))).toBe(false);
    expect(h).not.toContain(textHash('Buy milk'));
    // A Firestore document id: no slash, not . or .., not __x__.
    expect(h).not.toMatch(/\/|^\.\.?$|^__.*__$/);
  });

  it('gives undefined for a sealed note with no key, never a plain hash', () => {
    expect(noteTextHash('n1', 'Buy milk', 'sealed', none)).toBeUndefined();
  });

  it('binds the note id and the key', () => {
    const k = newDataKey();
    const a = noteTextHash('n1', 'same', 'sealed', has(k));
    expect(noteTextHash('n2', 'same', 'sealed', has(k))).not.toBe(a);
    expect(noteTextHash('n1', 'same', 'sealed', has(newDataKey()))).not.toBe(a);
    expect(noteTextHash('n1', 'same', 'sealed', has(k))).toBe(a);
    // Length-prefixed: moving characters between id and text changes it.
    expect(noteTextHash('n1s', 'ame', 'sealed', has(k))).not.toBe(a);
  });
});

describe('noteTextHashMatches', () => {
  const k = newDataKey();

  it('checks a plain hash as a plain one, whatever the note is now', () => {
    expect(noteTextHashMatches('n1', textHash('old'), 'old', none)).toBe(true);
    expect(noteTextHashMatches('n1', textHash('old'), 'new', none)).toBe(false);
    // On a sealed note, a plain hash from before keyed hashes still matches.
    expect(noteTextHashMatches('n1', textHash('old'), 'old', has(k))).toBe(true);
  });

  it('checks a keyed hash as a keyed one, under its note', () => {
    const h = noteTextHash('n1', 'old', 'sealed', has(k));
    expect(noteTextHashMatches('n1', h, 'old', has(k))).toBe(true);
    expect(noteTextHashMatches('n1', h, 'new', has(k))).toBe(false);
    expect(noteTextHashMatches('n2', h, 'old', has(k))).toBe(false);
  });

  it('cannot tell without the key, or for a version it does not know', () => {
    const h = noteTextHash('n1', 'old', 'sealed', has(k));
    expect(noteTextHashMatches('n1', h, 'old', none)).toBeUndefined();
    expect(noteTextHashMatches('n1', `k2.${h!.slice(3)}`, 'old', has(k))).toBeUndefined();
  });

  it('no hash is no match, and a plain hash never reads the key', () => {
    const key = vi.fn(has(k));
    expect(noteTextHashMatches('n1', undefined, 'x', key)).toBe(false);
    expect(noteTextHashMatches('n1', '', 'x', key)).toBe(false);
    noteTextHashMatches('n1', textHash('x'), 'x', key);
    expect(key).not.toHaveBeenCalled();
  });
});

describe('itemHash', () => {
  it('is 16 hex of SHA-256 for a plain note, as item run ids were', async () => {
    const key = vi.fn(none);
    const sha = toHex(new Uint8Array(await subtle.digest('SHA-256', utf8('find a plumber'))));
    expect(itemHash('n1', 'find a plumber', 'plain', key)).toBe(sha.slice(0, 16));
    expect(key).not.toHaveBeenCalled();
  });

  it('is keyed for a sealed note, apart from the body hash of the same words', async () => {
    const k = newDataKey();
    const h = itemHash('n1', 'find a plumber', 'sealed', has(k))!;
    expect(h).toMatch(/^k1\.[0-9a-f]{16}$/);
    expect(h).toBe(await webKeyed(k, 'item-key', 'n1', 'find a plumber', 16));
    expect(noteTextHash('n1', 'find a plumber', 'sealed', has(k))!.slice(0, 19)).not.toBe(h);
    expect(itemHash('n2', 'find a plumber', 'sealed', has(k))).not.toBe(h);
    expect(itemHash('n1', 'find a plumber', 'sealed', none)).toBeUndefined();
  });
});

describe('hashForm', () => {
  it('is sealed when any field of the note is', () => {
    expect(hashForm(PLAIN_FORMS)).toBe('plain');
    expect(hashForm(undefined)).toBe('plain');
    expect(hashForm(SEALED_FORMS)).toBe('sealed');
    expect(hashForm({ ...PLAIN_FORMS, title: 'sealed' })).toBe('sealed');
  });
});
