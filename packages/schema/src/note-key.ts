// A gardener's note data key, derived (note encryption step 2, Eric,
// 2026-11-12; DESIGN.md, "Note encryption", Key custody). The Worker
// holds one master secret and derives each gardener's data key from it
// with HKDF-SHA-256; nothing is stored. This module is the derivation
// alone, pure WebCrypto with no imports, so the Worker, the functions
// emulator's stand-in and the e2e static server (which loads this file
// as TypeScript, through Node's type stripping) derive alike and cannot
// drift. Erasable TypeScript only, for that reason.

/** The key version a fresh derivation uses; a rotation adds the next. */
export const NOTE_KEY_VERSION = 1;
/** Every key version this build can derive. */
export const NOTE_KEY_VERSIONS: readonly number[] = [1];

/** The master secret's length, and each data key's. */
const KEY_BYTES = 32;
/** The longest uid Firebase Auth makes. */
const MAX_UID = 128;

/**
 * HKDF's info for one gardener's key at one version: length-prefixed
 * parts, as `aadFor` writes them, so no two (version, uid) pairs encode
 * alike. Changing it changes every key: never do.
 */
export function noteKeyInfo(uid: string, version: number): Uint8Array<ArrayBuffer> {
  if (!uid || uid.length > MAX_UID) throw new RangeError('not a uid');
  if (!NOTE_KEY_VERSIONS.includes(version)) throw new RangeError(`no key version ${version}`);
  const parts = ['mossgoblin/note-key', `v${version}`, uid].map((p) => utf8.encode(p));
  const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of parts) {
    view.setUint32(at, p.length);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

/**
 * The raw 32 bytes of `uid`'s data key at `version`: HKDF-SHA-256 of
 * the master, no salt (the master is uniformly random), `noteKeyInfo`
 * as info. The same master, uid and version always give the same key.
 */
export async function deriveNoteKey(
  master: Uint8Array,
  uid: string,
  version: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (master.length !== KEY_BYTES) throw new RangeError(`the master is ${KEY_BYTES} bytes`);
  const info = noteKeyInfo(uid, version);
  const ikm = await crypto.subtle.importKey('raw', new Uint8Array(master), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    ikm,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** The master secret from its base64 (as `wrangler secret put` holds it), or undefined. */
export function masterFromBase64(text: string | undefined): Uint8Array<ArrayBuffer> | undefined {
  const bytes = text ? base64ToBytes(text.trim()) : undefined;
  return bytes?.length === KEY_BYTES ? bytes : undefined;
}

/** A key's wire form: `{ v, key }`, the key as standard base64. */
export interface NoteKeyWire {
  v: number;
  key: string;
}

/** The raw key and version a `{ v, key }` answer holds, or undefined if it is not one. */
export function noteKeyFromWire(
  value: unknown,
): { v: number; bytes: Uint8Array<ArrayBuffer> } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { v, key } = value as Record<string, unknown>;
  if (typeof v !== 'number' || !NOTE_KEY_VERSIONS.includes(v) || typeof key !== 'string') {
    return undefined;
  }
  const bytes = base64ToBytes(key);
  return bytes?.length === KEY_BYTES ? { v, bytes } : undefined;
}

/** Standard base64 with padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Standard base64 (padding optional), or undefined when it is not. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

const utf8 = /* @__PURE__ */ new TextEncoder();
