// Sealed note text (note encryption step 1, Eric, 2026-11-12; DESIGN.md,
// "Note encryption"). A sealed value is still a string, kept in the same
// field as the plain text it replaces (`body`, `title`), and says for
// itself that it is sealed: a private-use sentinel, a version tag, then
// base64url(nonce || ciphertext || tag) of AES-256-GCM. Plain and sealed
// values coexist, so a migration can go note by note and field by field.
//
// Nothing reads or writes these yet: this module is the format alone.
//
// Synchronous on purpose: notes flow through signals and computeds in
// the app and through many store helpers on the server, and WebCrypto's
// AES-GCM is async only. @noble/ciphers (audited, no dependencies) gives
// a synchronous AES-GCM whose output is the standard one, so WebCrypto or
// any other AES-GCM can open what this seals (sealed.spec.ts checks it).
import { gcm } from '@noble/ciphers/aes.js';

/**
 * Starts every sealed value: U+E000, the first private-use code point.
 * It has no glyph and no keyboard makes it, so ordinary typed or pasted
 * text does not start with it followed by a version tag.
 */
export const SEAL_SENTINEL = '\uE000';
/** The current format: AES-256-GCM, 12-byte nonce, 16-byte tag. */
export const SEAL_VERSION = 'mg1';
const PREFIX_V1 = '\uE000mg1.'; // SEAL_SENTINEL, SEAL_VERSION, a dot
/** The sentinel and any version tag, `mg` then digits then a dot. */
const SEALED_SHAPE = /^\uE000mg[0-9]+\./;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The note fields that may hold sealed text. A history version of a
 * note's body is sealed as `body`: the authenticated data names the note
 * and the field, not the document path, so a copy under
 * `notes/{id}/history/{v}` opens with the note's own aad.
 */
export const SEALED_FIELDS = ['body', 'title'] as const;
export type SealedField = (typeof SEALED_FIELDS)[number];

export type SealErrorCode =
  /** Starts like a sealed value but is not one: bad base64url, too short. */
  | 'malformed'
  /** A version tag this build does not know. */
  | 'unknown-version'
  /** Did not authenticate: wrong key, wrong aad, or tampered with. */
  | 'failed'
  /** `sealText` was handed a value that is already sealed. */
  | 'already-sealed';

/** Why a value could not be sealed or opened. Never holds key or text. */
export class SealError extends Error {
  override readonly name = 'SealError';
  constructor(
    readonly code: SealErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Each key's bytes, out of reach of anything outside this module. */
const keyBytes = /* @__PURE__ */ new WeakMap<DataKey, Uint8Array>();

/**
 * A user's 256-bit data key. Opaque so it cannot be logged or serialized
 * by accident; `exportDataKey` gives the raw bytes, for wrapping. Made
 * with `newDataKey` or `importDataKey`.
 */
export class DataKey {
  declare private readonly brand: never;
  toString(): string {
    return '[DataKey]';
  }
  toJSON(): string {
    return '[DataKey]';
  }
}

function bytesOf(key: DataKey): Uint8Array {
  const bytes = keyBytes.get(key);
  if (!bytes) throw new TypeError('not a data key');
  return bytes;
}

/** A fresh random data key, from the platform CSPRNG. */
export function newDataKey(): DataKey {
  const key = new DataKey();
  keyBytes.set(key, randomBytes(KEY_BYTES));
  return key;
}

/** The key's 32 raw bytes (a copy), to wrap with whatever holds keys. */
export function exportDataKey(key: DataKey): Uint8Array<ArrayBuffer> {
  return bytesOf(key).slice();
}

/** A data key from 32 raw bytes, as unwrapped. Throws on any other length. */
export function importDataKey(bytes: Uint8Array): DataKey {
  if (!(bytes instanceof Uint8Array) || bytes.length !== KEY_BYTES) {
    throw new RangeError(`a data key is ${KEY_BYTES} bytes`);
  }
  const key = new DataKey();
  keyBytes.set(key, bytes.slice());
  return key;
}

/**
 * The authenticated data for one field of one note: binds a sealed value
 * to the user, the note and the field, so it cannot be moved to another
 * user's note, another note, or from title to body, and still open. Each
 * part is length-prefixed, so no two triples encode alike. It names no
 * format version, so a later format can bind the same triple.
 */
export function aadFor(uid: string, noteId: string, field: SealedField): Uint8Array<ArrayBuffer> {
  if (!uid) throw new RangeError('aadFor needs a uid');
  if (!noteId) throw new RangeError('aadFor needs a note id');
  if (!(SEALED_FIELDS as readonly string[]).includes(field)) {
    throw new RangeError(`not a sealed field: ${field}`);
  }
  return lengthPrefixed(['mossgoblin/note-field', uid, noteId, field]);
}

/** Whether `value` is a sealed value (of any version, well formed or not). */
export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && SEALED_SHAPE.test(value);
}

/**
 * Seals `plaintext` under `key` and `aad` with a fresh random nonce, so
 * sealing the same text twice gives different values. The sealed value
 * reveals the text's length in bytes, nothing else. Throws `SealError`
 * ('already-sealed') on a sealed value rather than sealing it again.
 * Text goes in as UTF-8, so a lone surrogate comes back as U+FFFD, as
 * Firestore already stores it.
 */
export function sealText(key: DataKey, aad: Uint8Array, plaintext: string): string {
  if (typeof plaintext !== 'string') throw new TypeError('sealText seals strings');
  if (isSealed(plaintext)) throw new SealError('already-sealed', 'value is already sealed');
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = gcm(bytesOf(key), nonce, aad).encrypt(utf8.encode(plaintext));
  const out = new Uint8Array(NONCE_BYTES + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, NONCE_BYTES);
  return PREFIX_V1 + toBase64Url(out);
}

/**
 * The text of `value`. A value that is not sealed comes back unchanged,
 * so plain and sealed notes read alike. A sealed value that does not
 * open throws `SealError`, never returns garbage: 'unknown-version',
 * 'malformed', or 'failed' (wrong key, wrong aad or tampered, which
 * AES-GCM cannot tell apart).
 */
export function openText(key: DataKey, aad: Uint8Array, value: string): string {
  if (!isSealed(value)) return value;
  if (!value.startsWith(PREFIX_V1)) {
    throw new SealError('unknown-version', 'sealed with an unknown version');
  }
  const bytes = fromBase64Url(value.slice(PREFIX_V1.length));
  if (!bytes || bytes.length < NONCE_BYTES + TAG_BYTES) {
    throw new SealError('malformed', 'sealed value is malformed');
  }
  let plain: Uint8Array;
  try {
    plain = gcm(bytesOf(key), bytes.subarray(0, NONCE_BYTES), aad).decrypt(
      bytes.subarray(NONCE_BYTES),
    );
  } catch {
    throw new SealError('failed', 'sealed value did not open');
  }
  try {
    return utf8Strict.decode(plain);
  } catch {
    // Authenticated but not UTF-8: only a writer bug could seal that.
    throw new SealError('malformed', 'sealed value is not text');
  }
}

const utf8 = /* @__PURE__ */ new TextEncoder();
const utf8Strict = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function lengthPrefixed(parts: string[]): Uint8Array<ArrayBuffer> {
  const encoded = parts.map((p) => utf8.encode(p));
  const out = new Uint8Array(encoded.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of encoded) {
    view.setUint32(at, p.length);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
let b64urlIndex: Map<string, number> | undefined;

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

/**
 * Strict base64url without padding: any other character, an impossible
 * length or stray low bits give null, so each byte string has exactly
 * one sealed spelling.
 */
function fromBase64Url(text: string): Uint8Array | null {
  const index = (b64urlIndex ??= new Map([...B64URL].map((c, i) => [c, i])));
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (const c of text) {
    const v = index.get(c);
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) return null;
  return out;
}
