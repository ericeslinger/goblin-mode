// A note written plain is sealed by the server (always sealed, Eric,
// 2026-11-15; DESIGN.md, "Note encryption", Always sealed). Every
// writer seals note text now, but an out-of-date app (an old service
// worker's cached copy) can still write a note plain, and with the
// migration's runner gone nothing else would ever seal it. So
// noteHistory, on every note write, looks at the document it was handed
// and, only when a sealed field or `baseHash` is still plain, seals that
// note here: the migration's per-note pass (2026-11-15, The migration),
// kept for this alone.
//
// The check costs nothing for a sealed write: it reads the snapshot the
// trigger already holds, before any key is asked for or any document
// read. The seal is a transaction that reads the note as it is now,
// changes the form of its text and its hash and nothing else (no
// `updatedAt`, `updatedBy` or `deviceId`, so no trigger takes it for an
// edit, and the write it fires finds nothing plain: no loop), and
// checks before writing that each sealed value opens back to exactly
// the text it replaces. A note it cannot seal (no key, text that does
// not open, too large, being imported) is left as stored and logged;
// its next write tries again.
//
// Every note value is sealed through `sealFields`, hashes through the
// codec: the sanctioned helpers, nothing beside them.
import {
  SEALED_FIELDS,
  type SealedField,
  fieldValue,
  isKeyedHash,
  isSealed,
  paths,
} from '@mossgoblin/schema';
import {
  type DocumentSnapshot,
  type Firestore,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore';
import {
  type NoteCodec,
  NoteSnap,
  SealedNoteError,
  sealFields,
  storedText,
} from '../mcp/note-text';

type Data = Record<string, unknown>;

/** How many of a note's newest History versions a hash's text is looked for in, as put back does. */
export const VERSIONS_SEARCHED = 50;

/**
 * What a hash is made of when the text it named is kept nowhere any
 * more (not the note's body, not a replaced text, not in History). A
 * hash matches only a text exactly equal to this one, which starts
 * with NUL and names itself, so in practice no note's text; its keyed
 * hash then matches no text, as the plain hash it replaces matched
 * none that is kept, so the merge, put back and Show changes behave
 * exactly as before, and nothing guessable is left.
 */
export const UNKEPT_TEXT = '\u0000mossgoblin/text-no-longer-kept';

/**
 * How long a recipe import asked for is left to its own function
 * (recipeImport, 300 s, and a retry) before a plain write of it is
 * sealed anyway.
 */
export const IMPORT_FRESH_MS = 15 * 60_000;

/**
 * Firestore's limit for one document, less room for its name and what
 * an estimate leaves out: a document sealed past it is not written.
 */
export const MAX_DOC_BYTES = 1_048_576 - 16_384;

/** Sealed, a document would pass Firestore's limit: it is left as stored. */
export class TooLargeToSeal extends Error {
  override readonly name = 'TooLargeToSeal';
}

/** What was sealed did not open back to the same text: nothing is written. */
export class NotVerified extends Error {
  override readonly name = 'NotVerified';
}

const utf8 = new TextEncoder();
const bytesOf = (s: string) => utf8.encode(s).length;

/**
 * The stored size of a sealed value of `text`, in bytes: U+E000 (three
 * bytes in UTF-8), `mg1.`, and base64url of the 12-byte nonce, the text
 * and the 16-byte tag (sealed.ts).
 */
export function sealedBytes(text: string): number {
  return 3 + 4 + Math.ceil(((12 + bytesOf(text) + 16) * 4) / 3);
}

/** Firestore's storage size of a value (a string's bytes and one, a map's names too). */
function valueBytes(v: unknown): number {
  if (typeof v === 'string') return bytesOf(v) + 1;
  if (typeof v === 'number' || v instanceof Timestamp) return 8;
  if (typeof v === 'boolean' || v === null || v === undefined) return 1;
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + valueBytes(x), 0);
  if (typeof v === 'object') {
    return Object.entries(v as Data).reduce((n, [k, x]) => n + bytesOf(k) + 1 + valueBytes(x), 0);
  }
  return 16;
}

/**
 * Throws TooLargeToSeal when `stored`, with each plain string of the
 * values in `plain` sealed, would pass MAX_DOC_BYTES: estimated before
 * anything is sealed.
 */
function checkSealedSize(stored: Data, plain: readonly unknown[]): void {
  let size = 32 + valueBytes(stored);
  const grow = (t: unknown) => {
    if (typeof t === 'string' && !isSealed(t)) size += sealedBytes(t) - bytesOf(t);
  };
  for (const v of plain) (Array.isArray(v) ? v : [v]).forEach(grow);
  if (size > MAX_DOC_BYTES) throw new TooLargeToSeal();
}

/** Whether a stored value of a sealed field holds any plain text. */
function holdsPlain(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && !isSealed(v));
  return typeof value === 'string' && !isSealed(value);
}

const plainHash = (hash: unknown): hash is string =>
  typeof hash === 'string' && hash !== '' && !isKeyedHash(hash);

/**
 * Whether a stored note holds anything plain that every writer now
 * seals: a sealed field's text, or a plain `baseHash`. Reads only
 * `stored`, so a sealed write costs nothing more.
 */
export function holdsPlainText(stored: Data | undefined): boolean {
  if (!stored) return false;
  return (
    SEALED_FIELDS.some((f) => holdsPlain(fieldValue(stored, f))) || plainHash(stored['baseHash'])
  );
}

/**
 * The text of note `noteId` whose plain hash is `hash`: one of `known`
 * (texts the caller already holds opened, such as the body now and the
 * one the write replaced), the replaced text kept under that hash, or
 * one of its newest History versions, each opened; undefined when none
 * of them is it. Checked as the kind of hash it is (`hashMatcher`), as
 * the merge and put back check it.
 */
async function textOfHash(
  tx: Transaction,
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  noteId: string,
  hash: string,
  known: readonly string[],
): Promise<string | undefined> {
  const matches = await codec.hashMatcher(noteId, 'sealed', [hash]);
  const found = known.find((t) => matches(hash, t));
  if (found !== undefined) return found;
  const opened = async (d: Data | undefined) => {
    if (!d) return undefined;
    try {
      return await codec.open(noteId, 'body', storedText(d, 'body'));
    } catch (err) {
      if (err instanceof SealedNoteError) return undefined;
      throw err;
    }
  };
  const replaced = await opened(
    (await tx.get(db.doc(`${paths.replaced(uid, noteId)}/${hash}`))).data(),
  );
  if (replaced !== undefined && matches(hash, replaced)) return replaced;
  const kept = await tx.get(
    db.collection(paths.history(uid, noteId)).orderBy('savedAt', 'desc').limit(VERSIONS_SEARCHED),
  );
  for (const d of kept.docs) {
    const text = await opened(d.data());
    if (text !== undefined && matches(hash, text)) return text;
  }
  return undefined;
}

/** Checks that `written[field]` opens back to `text` as field `field` of note `noteId`. */
async function opensBack(
  codec: NoteCodec,
  noteId: string,
  field: SealedField,
  written: unknown,
  text: unknown,
): Promise<void> {
  const one = async (w: unknown, t: unknown) => {
    if (typeof w !== 'string' || typeof t !== 'string' || !isSealed(w)) throw new NotVerified();
    if ((await codec.open(noteId, field, w)) !== t) throw new NotVerified();
  };
  if (Array.isArray(text)) {
    if (!Array.isArray(written) || written.length !== text.length) throw new NotVerified();
    for (let i = 0; i < text.length; i++) await one(written[i], text[i]);
  } else await one(written, text);
}

/** Sealed elements of the other names are checked and kept as they are; plain ones sealed. */
const KEEP_SEALED: ReadonlySet<string> = new Set(['synonyms']);

/**
 * A recipe whose import was asked for within IMPORT_FRESH_MS (review on
 * #277): recipeImport runs on every write while `importState` is
 * `requested`, so a write now would only race its own run, and the
 * note is sealed at the import's own next write instead. Older, it is
 * sealed like the rest: the write starts recipeImport again, which
 * claims the import in a transaction (`requested` to `working`), so it
 * is read once, as if Eric had tapped Try again. There is no claim time
 * on the note, so the age is its `updatedAt`, which every ask writes
 * (or `createdAt`). A recipe `working` is sealed whatever its age:
 * recipeImport returns at once for it, and `fillImport` reads the note
 * in its own transaction, opened, and writes it sealed, so a write of
 * form alone, in a transaction, can neither be lost to it nor change
 * what it reads.
 */
function importJustAsked(stored: Data, now: number): boolean {
  if (stored['importState'] !== 'requested') return false;
  const at = stored['updatedAt'] ?? stored['createdAt'];
  return at instanceof Timestamp && now - at.toMillis() < IMPORT_FRESH_MS;
}

/** What `sealNote` did: sealed it, found nothing plain, or left an import in progress. */
export type SealedNote = { result: 'sealed'; unkept: boolean } | { result: 'already' | 'busy' };

/**
 * Note `id`: every sealed field still plain, sealed under its id, and a
 * plain `baseHash` keyed (of the same text, found among `known`, the
 * replaced texts or History, or of nothing when that text is kept
 * nowhere). Nothing else of the note is written. Throws SealedNoteError
 * when the note cannot be opened or the key had, TooLargeToSeal and
 * NotVerified as they say; in each case nothing is written.
 */
export async function sealNote(
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  id: string,
  now: number,
  known: readonly string[] = [],
): Promise<SealedNote> {
  const ref = db.doc(paths.note(uid, id));
  return db.runTransaction(async (tx): Promise<SealedNote> => {
    const raw = await tx.get(ref);
    if (!raw.exists) return { result: 'already' };
    const stored = raw.data()!;
    if (!holdsPlainText(stored)) return { result: 'already' };
    if (importJustAsked(stored, now)) return { result: 'busy' };
    const note = await NoteSnap.open(codec, raw);
    // Locked: its own error, which says whether the key was missing or
    // its text did not open.
    if (note.locked) note.data();
    const plain = SEALED_FIELDS.filter((f) => holdsPlain(fieldValue(stored, f)));
    checkSealedSize(
      stored,
      plain.map((f) => fieldValue(stored, f)),
    );
    const opened = note.known()!;
    const base = stored['baseHash'];
    let unkept = false;
    const update: Data = {};
    // `source.text` goes by its dotted path, so the rest of `source` is untouched.
    for (const f of plain) update[f] = fieldValue(stored, f);
    if (plainHash(base)) {
      const text = await textOfHash(tx, db, codec, uid, id, base, [
        String(opened['body'] ?? ''),
        ...known,
      ]);
      update['baseHash'] = await codec.hashText(id, text ?? UNKEPT_TEXT);
      unkept = text === undefined;
    }
    const written = await sealFields(codec, id, update, KEEP_SEALED);
    for (const f of plain) {
      await opensBack(codec, id, f, fieldValue(written, f), fieldValue(opened, f));
    }
    tx.update(ref, written);
    return { result: 'sealed', unkept };
  });
}

export interface PlainLog {
  info(message: string, fields?: unknown): void;
  warn(message: string, fields?: unknown): void;
}

/**
 * noteHistory's last step: when the note as this write left it
 * (`afterSnap`) holds anything plain, seal it (`sealNote`). Nothing is
 * read, and no key asked for, when it holds nothing plain, which is
 * every write from an up-to-date writer. `known` are texts of the note
 * the trigger already opened (the body it replaced), so a plain
 * `baseHash` naming one is keyed to it. Never throws: a note it cannot
 * seal is left as stored and logged by its id and the reason, never
 * text, and tried again at its next write. Answers what it did, or
 * undefined when there was nothing to do.
 */
export async function sealWrittenPlain(
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  noteId: string,
  afterSnap: DocumentSnapshot | undefined,
  known: readonly string[],
  now: number,
  log: PlainLog,
): Promise<SealedNote['result'] | 'left' | undefined> {
  if (!afterSnap?.exists || !holdsPlainText(afterSnap.data())) return undefined;
  try {
    const done = await sealNote(db, codec, uid, noteId, now, known);
    if (done.result === 'sealed') {
      log.info('noteHistory sealed a note written plain', { noteId, baseUnkept: done.unkept });
    }
    return done.result;
  } catch (err) {
    const reason =
      err instanceof SealedNoteError
        ? err.reason
        : err instanceof Error
          ? err.name || 'Error'
          : typeof err;
    log.warn('noteHistory left a note written plain as stored; its next write tries again', {
      noteId,
      reason,
    });
    return 'left';
  }
}
