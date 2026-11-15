import { describe, expect, it } from 'vitest';
import { KEY_CHECK_PURPOSE, isKeyCheckNonce, keyCheckProof } from './key-check';
import { exportDataKey, importDataKey, keyedDigest, newDataKey } from './sealed';
import { toHex } from './sha256';
import { noteTextHash } from './text-hash';

// The check before sealing is switched on (2026-11-15): both sides
// prove the key they hold by a digest of the app's nonce.

const NONCE = 'AAECAwQFBgcICQoLDA0ODw';

describe('keyCheckProof', () => {
  it('is the same for the same key, gardener and nonce, on either side', () => {
    const key = newDataKey();
    const copy = importDataKey(exportDataKey(key));
    expect(keyCheckProof(copy, 'u1', NONCE)).toBe(keyCheckProof(key, 'u1', NONCE));
    expect(keyCheckProof(key, 'u1', NONCE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for another key, gardener or nonce', () => {
    const key = newDataKey();
    const proof = keyCheckProof(key, 'u1', NONCE);
    expect(keyCheckProof(newDataKey(), 'u1', NONCE)).not.toBe(proof);
    expect(keyCheckProof(key, 'u2', NONCE)).not.toBe(proof);
    expect(keyCheckProof(key, 'u1', `${NONCE}x`)).not.toBe(proof);
  });

  it('says nothing of the key: it is a digest under its own purpose, never the key’s bytes', () => {
    const key = newDataKey();
    const proof = keyCheckProof(key, 'u1', NONCE);
    expect(proof).not.toContain(toHex(exportDataKey(key)));
    expect(proof).toBe(toHex(keyedDigest(key, [KEY_CHECK_PURPOSE, 'v1', 'u1', NONCE])));
    // Not a text hash of the same words, which starts with its own version.
    expect(noteTextHash('u1', NONCE, 'sealed', () => key)).not.toContain(proof.slice(0, 32));
  });

  it('takes only a nonce of the expected shape', () => {
    expect(isKeyCheckNonce(NONCE)).toBe(true);
    expect(isKeyCheckNonce('short')).toBe(false);
    expect(isKeyCheckNonce(`${NONCE}+/`)).toBe(false);
    expect(isKeyCheckNonce('a'.repeat(65))).toBe(false);
    expect(isKeyCheckNonce(42)).toBe(false);
    expect(() => keyCheckProof(newDataKey(), 'u1', 'short')).toThrow(RangeError);
    expect(() => keyCheckProof(newDataKey(), '', NONCE)).toThrow(RangeError);
  });
});
