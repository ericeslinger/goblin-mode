// SHA-256, HMAC-SHA-256 and HKDF-SHA-256, synchronous (note encryption,
// keyed hashes, 2026-11-14; DESIGN.md, "Note encryption"). WebCrypto
// has all three but only async, and the hashes they make are compared
// inside synchronous code on both sides (the app's save and Show
// changes, the server's merge), as sealed.ts opens text synchronously.
// The algorithms come from @noble/hashes (audited, no dependencies),
// the sibling of the @noble/ciphers that sealed.ts uses (Eric,
// 2026-11-15, #274); until then they were written out here. This module
// keeps the names and signatures callers use, and sha256.spec.ts checks
// each against WebCrypto and the RFC vectors.
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const DIGEST = 32;

/** SHA-256 of `data`. */
export function sha256(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return nobleSha256(data);
}

/** HMAC-SHA-256 of `message` under `key` (RFC 2104). */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array<ArrayBuffer> {
  return hmac(nobleSha256, key, message);
}

/** HKDF-SHA-256 (RFC 5869): `length` bytes from `ikm`, `salt` and `info`. */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array<ArrayBuffer> {
  if (length < 1 || length > 255 * DIGEST) throw new RangeError('HKDF length out of range');
  // An empty salt keys the HMAC as the RFC's absent salt, a block of
  // zeros as long as the digest, does: HMAC pads its key with zeros.
  return hkdf(nobleSha256, ikm, salt, info, length);
}

/** Lower-case hex of `bytes`. */
export function toHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}
