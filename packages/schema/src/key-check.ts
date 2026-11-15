// The check before sealing is switched on (note encryption, the
// gardener's switch, 2026-11-15; DESIGN.md, "Note encryption"). The app
// asks the Worker for its gardener's key, and a callable asks for the
// same key through the functions' own path; each side then proves which
// key it holds without saying it: a keyed digest of a fresh nonce the
// app chose, under the data key's text-hash key (`keyedDigest`), with a
// purpose of its own. The text hashes start with their version `k1`
// and this with `mossgoblin/key-check`, so a proof is never a text
// hash and a text hash never a proof.
import { type DataKey, keyedDigest } from './sealed';
import { toHex } from './sha256';

/** What a proof binds first: its purpose and version. Never change it. */
export const KEY_CHECK_PURPOSE = 'mossgoblin/key-check';
export const KEY_CHECK_VERSION = 'v1';

/** A nonce the app sends: base64url, 22 to 64 characters (128 to 384 bits). */
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;

export function isKeyCheckNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE.test(value);
}

/**
 * The proof that `key` is the key held, for `nonce`: 64 hex characters
 * of HMAC-SHA-256 under the key's text-hash key over the length-prefixed
 * purpose, version, uid and nonce. It says nothing of the key, and a
 * proof for one nonce or gardener is no proof for another.
 */
export function keyCheckProof(key: DataKey, uid: string, nonce: string): string {
  if (!uid) throw new RangeError('a key check needs a uid');
  if (!isKeyCheckNonce(nonce)) throw new RangeError('not a key check nonce');
  return toHex(keyedDigest(key, [KEY_CHECK_PURPOSE, KEY_CHECK_VERSION, uid, nonce]));
}
