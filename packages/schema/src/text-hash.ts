// Hashes of note text, keyed for sealed notes (note encryption, keyed
// hashes, 2026-11-14; DESIGN.md, "Note encryption"). Four things are
// stored as a hash of a note's words: a write's `baseHash`, the id of a
// replaced text (`notes/{id}/replaced/{hash}`), the body hash an
// activity entry keeps in `before`, and the hash in an item run's id.
// A plain hash lets anyone holding the database check a guess at a
// short text against it, so for a sealed note each is keyed instead:
// HMAC-SHA-256 under a key derived from the gardener's data key
// (`keyedDigest`, sealed.ts), binding the note id, so the same text in
// two notes hashes apart.
//
// A keyed hash says so by its shape, `k1.` then hex, which a plain hash
// never has (`textHash` is base36, a dash and hex; an item's is hex
// alone), so a reader computes the kind the stored hash is and a plain
// hash is never taken for a keyed one. Plain notes keep the plain
// hashes exactly as before, and nothing asks for a key for them.
//
// This is the one place note text is hashed for storing or matching:
// `hash-boundary.spec.ts` fails on a bare `textHash(` elsewhere in the
// app or the functions.
import { textHash } from './merge';
import { type DataKey, keyedDigest } from './sealed';
import { type NoteForm, type NoteForms, recordForm } from './sealed-note';
import { sha256, toHex } from './sha256';

/** The keyed hash format's version, bound into every keyed hash. */
export const KEYED_HASH_VERSION = 'k1';
const KEYED_PREFIX = `${KEYED_HASH_VERSION}.`;
/** Any keyed hash version: `k`, digits, a dot. */
const KEYED_SHAPE = /^k[0-9]+\./;
/** Hex characters of a body hash (128 bits) and of an item's (64 bits, as before). */
const BODY_HEX = 32;
const ITEM_HEX = 16;

/**
 * The gardener's data key, read only when a keyed hash is made or
 * matched, so with only plain notes it is never read (the app reads a
 * signal, the server a key it asked for once).
 */
export type KeyGetter = () => DataKey | undefined;

/** Whether `hash` is a keyed hash (of any version). */
export function isKeyedHash(hash: unknown): hash is string {
  return typeof hash === 'string' && KEYED_SHAPE.test(hash);
}

/**
 * Whether hashes of a note's text are keyed: when any field of the note
 * is stored sealed (`recordForm`, the rule of text about notes, step 3e).
 * Not the body's form alone: a plain body beside a sealed title is the
 * note's own words in the clear already, but the rule is the one every
 * record about a sealed note follows, and a hash made today stays keyed
 * once the rest of the note is sealed.
 */
export function hashForm(forms: NoteForms | undefined): NoteForm {
  return recordForm(forms);
}

const utf8 = /* @__PURE__ */ new TextEncoder();

function keyedHex(key: DataKey, purpose: string, noteId: string, text: string, hex: number) {
  if (!noteId) throw new RangeError('a keyed hash needs a note id');
  return (
    KEYED_PREFIX +
    toHex(keyedDigest(key, [KEYED_HASH_VERSION, purpose, noteId, text])).slice(0, hex)
  );
}

/**
 * The hash of `text`, the body of note `noteId`, to store as a
 * `baseHash`, a replaced text's id or an activity entry's `before.body`:
 * `textHash` when `form` is plain, as before; for a sealed note the
 * keyed hash, or undefined when there is no key, so a writer without
 * the key leaves things as stored rather than writing a plain hash in
 * its place.
 */
export function noteTextHash(
  noteId: string,
  text: string,
  form: NoteForm,
  key: KeyGetter,
): string | undefined {
  if (form === 'plain') return textHash(text);
  const k = key();
  return k ? keyedHex(k, 'note-body', noteId, text, BODY_HEX) : undefined;
}

/**
 * Whether stored `hash` is the hash of `text`, the body of note
 * `noteId`, computed the way the hash itself says: plain against
 * `textHash`, keyed against the keyed hash. So a plain hash written
 * before the note was sealed still matches, and a mismatch of kinds is
 * never a match. Undefined when it cannot tell: a keyed hash with no
 * key, or of a version this build does not know. No hash is no match.
 */
export function noteTextHashMatches(
  noteId: string,
  hash: string | undefined,
  text: string,
  key: KeyGetter,
): boolean | undefined {
  if (!hash) return false;
  if (!isKeyedHash(hash)) return textHash(text) === hash;
  if (!hash.startsWith(KEYED_PREFIX)) return undefined;
  const k = key();
  return k ? keyedHex(k, 'note-body', noteId, text, BODY_HEX) === hash : undefined;
}

/**
 * The names part of a refile suggestion's key (`refile:{id}:{type}:
 * {names}`) for a sealed concept, or with the gardener's switch on
 * (2026-11-15): `k1.` and 32 hex characters of the keyed hash of the
 * normalized, sorted names, under purpose `refile-names` and the
 * concept's id, so the same names proposed again make the same key
 * without the key saying them. Undefined with no key.
 */
export function refileNamesHash(noteId: string, names: string, key: KeyGetter): string | undefined {
  const k = key();
  return k ? keyedHex(k, 'refile-names', noteId, names, BODY_HEX) : undefined;
}

/**
 * The hash part of an item run's id for the item keyed `itemKey` on
 * note `noteId`: 16 hex characters of SHA-256 of the key when `form` is
 * plain, as before; `k1.` and 16 hex characters of the keyed hash for a
 * sealed note, or undefined with no key.
 */
export function itemHash(
  noteId: string,
  itemKey: string,
  form: NoteForm,
  key: KeyGetter,
): string | undefined {
  if (form === 'plain') return toHex(sha256(utf8.encode(itemKey))).slice(0, ITEM_HEX);
  const k = key();
  return k ? keyedHex(k, 'item-key', noteId, itemKey, ITEM_HEX) : undefined;
}
