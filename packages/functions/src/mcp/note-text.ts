// A note's text as the tools see it (note encryption step 3b, Eric,
// 2026-11-12; DESIGN.md, "Note encryption", The tools). A note's `body`
// and `title` may be sealed (packages/schema/src/sealed.ts); the tools
// work on plain strings. Every note the tools read comes through
// `NoteSnap.open`, which opens the text, and every note they write goes
// through `NoteCodec.seal`, which seals a field when it was sealed
// before (NotesTools.writeNote). Nothing between needs to know.
//
// The gardener's key is asked for lazily, the first time a sealed value
// is met or a seal is needed, and once per codec at most, so with only
// plain notes nothing asks the key service at all.
//
// The triggers and callables that touch note text (step 3c, 2026-11-13)
// use the same codec, one per event or call: `sealFields` is the one way
// a field is sealed for a write, here and in NotesTools.writeNote.
//
// Since step 3d (2026-11-13) every sealed field of a note goes the same
// way, not only body and title: the other names, the instructions, the
// Send to ask and outcome, a recipe's import error and its source text
// (SEALED_FIELDS). Until 2026-11-15 the form a write kept was the one it
// found (`writtenForms`, shared with the app); now it is always sealed.
//
// Hashes of a note's text (keyed hashes, 2026-11-14) are made and
// matched here too, `hashText`, `hashMatcher` and `itemHash`, keyed for
// a sealed note (packages/schema/src/text-hash.ts) with the same key,
// asked for as lazily: never for a plain note with plain hashes.
//
// Always sealed (Eric, 2026-11-15, after the migration): every write
// through the codec seals every sealed field it writes, a new note's
// included, keys every hash it stores, and seals every record it writes
// about notes. There is no switch and nothing is written plain. Reading
// still opens plain values as they are (DESIGN.md, Always sealed): a
// replaced text kept before, a restored backup, a write from an
// out-of-date app, which noteHistory then seals (notes/seal-plain.ts).
// The key is asked for lazily, the first time a value is opened or
// sealed, once a codec at most.
import {
  type DataKey,
  type HabitAnswerKind,
  type NoteForm,
  type NoteForms,
  SEALED_FIELDS,
  SEALED_FORMS,
  SealError,
  type SealedField,
  type SealedFieldValue,
  type SealedListField,
  type SealedRecordCollection,
  type SealedRecordField,
  aadFor,
  fieldValue,
  formsFound,
  isKeyedHash,
  isSealed,
  isSealedValue,
  itemHash,
  noteTextHash,
  noteTextHashMatches,
  noteTitleHash,
  openHabitAnswer,
  openText,
  refileNamesHash,
  recordAadFor,
  sealHabitAnswer,
  sealText,
  withFieldValue,
} from '@mossgoblin/schema';
import type { DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import { ToolError } from './tool-error';

type Data = Record<string, unknown>;

export type { NoteForm, NoteForms };

/** Where the gardener's data key comes from: `dataKeyFor` in production. */
export type KeyFor = (uid: string) => Promise<DataKey>;

/** What an activity entry or summary says for a sealed title. */
export const SEALED_TITLE = 'Sealed note';
/** What a list says in place of a sealed note's text it could not open. */
export const SEALED_LEFT_OUT = 'Sealed: its text cannot be opened here, so it is left out.';

export type UnreadableReason = 'no-key' | 'did-not-open';

/**
 * A sealed note that cannot be opened here: no key (the service is not
 * set up, or did not answer) or a value that did not open. No tool reads
 * it or writes over it. Holds the note id and why, never text or a key.
 */
export class SealedNoteError extends ToolError {
  override readonly name = 'SealedNoteError';
  constructor(
    readonly noteId: string,
    readonly reason: UnreadableReason,
  ) {
    super(
      `note ${noteId} is sealed and cannot be opened here (${
        reason === 'no-key' ? 'its key is not available' : 'its sealed text did not open'
      }), so it is left as it is`,
    );
  }
}

/**
 * A record about notes (a suggestion, a run) whose sealed text cannot
 * be opened here (step 3e, 2026-11-13): no key, or a value that did not
 * open. Holds the collection, the record id and why, never text or a
 * key; its message is safe to store as an outcome.
 */
export class SealedRecordError extends ToolError {
  override readonly name = 'SealedRecordError';
  constructor(
    readonly collection: SealedRecordCollection,
    readonly docId: string,
    readonly reason: UnreadableReason,
  ) {
    super(
      `this ${collection === 'proposals' ? 'suggestion' : 'run'} is sealed and cannot be opened ` +
        `here (${
          reason === 'no-key' ? 'its key is not available' : 'its sealed text did not open'
        }), so nothing was done`,
    );
  }
}

/**
 * A habit's answer that cannot be sealed or opened here (#324 step 6,
 * 2026-11-22): no key (the service is not set up, or did not answer),
 * or a stored answer that did not open. Holds the habit, the day and
 * why, never text or a key. Sealing refused, nothing is written: an
 * answer is never stored plain, as no note text is.
 */
export class SealedAnswerError extends ToolError {
  override readonly name = 'SealedAnswerError';
  constructor(
    readonly habit: string,
    readonly date: string,
    readonly reason: UnreadableReason,
  ) {
    super(
      reason === 'no-key'
        ? `the answer for ${date} cannot be sealed or opened here: its key is not ` +
            'available, so nothing was written'
        : `the answer for ${date} is sealed and did not open here, so it is left as it is`,
    );
  }
}

/** One gardener's opener and sealer, for one request. */
export class NoteCodec {
  private key?: Promise<DataKey>;

  constructor(
    private readonly uid: string,
    private readonly keyFor: KeyFor,
  ) {}

  /** The key, asked for once; a failed ask stays failed for this codec. */
  private dataKey(
    noteId: string,
    refused: () => Error = () => new SealedNoteError(noteId, 'no-key'),
  ): Promise<DataKey> {
    if (!this.key) {
      this.key = this.keyFor(this.uid);
      this.key.catch((err: unknown) => {
        // The client's errors name the failure, never a key or secret.
        const why = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown';
        console.warn(`note key not available, sealed notes left closed (${why})`);
      });
    }
    return this.key.catch(() => {
      throw refused();
    });
  }

  /** The text of `value`, field `field` of note `noteId`; plain passes through. */
  async open(noteId: string, field: SealedField, value: string): Promise<string> {
    if (!isSealed(value)) return value;
    const key = await this.dataKey(noteId);
    try {
      return openText(key, aadFor(this.uid, noteId, field), value);
    } catch (err) {
      if (err instanceof SealError) throw new SealedNoteError(noteId, 'did-not-open');
      throw err;
    }
  }

  /**
   * Whether `value`, stored sealed, opens as field `field` of note
   * `noteId`: it does, or this throws `SealedNoteError`. For a value put
   * back as it was stored (`sealFields`, `restored`), so a sealed string
   * recorded on one note or field never lands on another.
   */
  async check(noteId: string, field: SealedField, value: string): Promise<void> {
    await this.open(noteId, field, value);
  }

  /**
   * `text` as stored in field `field` of note `noteId`: sealed under that
   * note's id. Text that would read as a sealed value is refused: sealing
   * it is refused by the library, and it could never be told apart.
   */
  async seal(noteId: string, field: SealedField, text: string): Promise<string> {
    if (isSealed(text)) {
      throw new ToolError(`the ${field} cannot start with the sealed-text marker (U+E000 mg)`);
    }
    const key = await this.dataKey(noteId);
    return sealText(key, aadFor(this.uid, noteId, field), text);
  }

  /**
   * The hash of `text`, the body of note `noteId`, to store (`baseHash`,
   * a replaced text's id, an activity entry's `before.body`): always
   * keyed (2026-11-15). No key throws SealedNoteError, so nothing is
   * written with a plain hash in a keyed one's place.
   */
  async hashText(noteId: string, text: string): Promise<string> {
    const key = await this.dataKey(noteId);
    const hash = noteTextHash(noteId, text, 'sealed', () => key);
    if (hash === undefined) throw new SealedNoteError(noteId, 'no-key');
    return hash;
  }

  /**
   * The `titleHash` of a model title of note `noteId` and the text it
   * was made from (`noteTitleHash`, 2026-11-22): always keyed. No key
   * throws SealedNoteError, so no plain hash is stored in its place.
   */
  async titleHash(noteId: string, title: string, text: string): Promise<string> {
    const key = await this.dataKey(noteId);
    const hash = noteTitleHash(noteId, title, text, () => key);
    if (hash === undefined) throw new SealedNoteError(noteId, 'no-key');
    return hash;
  }

  /**
   * A matcher for hashes of note `noteId`'s body, each checked the way it
   * says it was made (`noteTextHashMatches`): a plain hash against
   * `textHash`, a keyed one against the keyed hash. The key is asked for
   * first when the note is sealed (`form`) or one of `hashes` is keyed,
   * and not otherwise; a keyed hash met without it throws (HashMatcher).
   */
  async hashMatcher(
    noteId: string,
    form: NoteForm,
    hashes: readonly (string | undefined)[] = [],
  ): Promise<HashMatcher> {
    let key: DataKey | undefined;
    if (form === 'sealed' || hashes.some(isKeyedHash)) {
      key = await this.dataKey(noteId).catch(() => undefined);
    }
    return (hash, text) => {
      const match = noteTextHashMatches(noteId, hash, text, () => key);
      if (match !== undefined) return match;
      throw new SealedNoteError(noteId, key ? 'did-not-open' : 'no-key');
    };
  }

  /**
   * A way to make the names part of a sealed refile suggestion's key
   * (`refileNamesHash`, 2026-11-15), with the key asked for once, here,
   * so the checks that use it stay synchronous. No key throws
   * SealedRecordError, so no suggestion is stored with its names in the
   * clear.
   */
  async namesHasher(): Promise<(noteId: string, names: string) => string> {
    const key = await this.dataKey(
      '',
      () => new SealedRecordError('proposals', 'refile', 'no-key'),
    );
    return (noteId, names) => refileNamesHash(noteId, names, () => key)!;
  }

  /**
   * The hash part of an item run's id (`itemRunId`) for the item whose
   * key is `item`, on note `noteId`: keyed for 'sealed', which every new
   * run is named by; 'plain' only to find a run named before its note
   * was sealed (agent/assigned.ts). No key throws SealedNoteError.
   */
  async itemHash(noteId: string, item: string, form: NoteForm): Promise<string> {
    const key = form === 'sealed' ? await this.dataKey(noteId) : undefined;
    const hash = itemHash(noteId, item, form, () => key);
    if (hash === undefined) throw new SealedNoteError(noteId, 'no-key');
    return hash;
  }

  /**
   * The text of `value`, field `field` of record `docId` in `collection`
   * (step 3e, 2026-11-13); plain passes through. A sealed one opens with
   * `recordAadFor`, so a value moved from another record, field or note
   * does not; one that does not open throws `SealedRecordError`. The key
   * is asked for as for a note, lazily and once a codec.
   */
  async openRecord<C extends SealedRecordCollection>(
    collection: C,
    docId: string,
    field: SealedRecordField<C>,
    value: string,
  ): Promise<string> {
    if (!isSealed(value)) return value;
    const key = await this.dataKey(docId, () => new SealedRecordError(collection, docId, 'no-key'));
    try {
      return openText(key, recordAadFor(this.uid, collection, docId, field), value);
    } catch (err) {
      if (err instanceof SealError) throw new SealedRecordError(collection, docId, 'did-not-open');
      throw err;
    }
  }

  /**
   * A habit's answer for `date`, as stored (#324 step 6, 2026-11-22):
   * padded and sealed under the day's own aad (`sealHabitAnswer`, as
   * the app seals one), with the same key as note text. No key throws
   * SealedAnswerError, so nothing is written with the answer plain.
   */
  async sealHabitAnswer(
    habitId: string,
    date: string,
    kind: HabitAnswerKind,
    text: string,
  ): Promise<string> {
    const key = await this.dataKey(habitId, () => new SealedAnswerError(habitId, date, 'no-key'));
    return sealHabitAnswer(key, this.uid, habitId, date, kind, text);
  }

  /**
   * The text of habit `habitId`'s stored answer for `date`. Throws
   * SealedAnswerError when there is no key or it does not open; the
   * key is asked for once a codec, as for notes.
   */
  async openHabitAnswer(habitId: string, date: string, stored: string): Promise<string> {
    const key = await this.dataKey(habitId, () => new SealedAnswerError(habitId, date, 'no-key'));
    try {
      return openHabitAnswer(key, this.uid, habitId, date, stored);
    } catch (err) {
      if (err instanceof SealError) throw new SealedAnswerError(habitId, date, 'did-not-open');
      throw err;
    }
  }

  /**
   * `text` as stored in field `field` of record `docId`: sealed under
   * that record's own aad, as every record about notes is (2026-11-15).
   * Text that reads as a sealed value is refused, as for a note.
   */
  async sealRecord<C extends SealedRecordCollection>(
    collection: C,
    docId: string,
    field: SealedRecordField<C>,
    text: string,
  ): Promise<string> {
    if (isSealed(text)) {
      throw new ToolError(`the ${field} cannot start with the sealed-text marker (U+E000 mg)`);
    }
    const key = await this.dataKey(docId, () => new SealedRecordError(collection, docId, 'no-key'));
    return sealText(key, recordAadFor(this.uid, collection, docId, field), text);
  }
}

/**
 * What `NoteCodec.hashMatcher` gives: whether a stored hash is the hash
 * of a text of that note. Throws SealedNoteError for a keyed hash it
 * cannot check (no key, or a version this build does not know), so a
 * merge or put back stops and leaves the note as stored rather than
 * deciding by guess.
 */
export type HashMatcher = (hash: string | undefined, text: string) => boolean;

/**
 * A stored note as the tools read it: `data()` and `get()` give its text
 * opened. A note whose sealed text did not open is `locked`: `data()`
 * and `get()` of that field throw `SealedNoteError`, so nothing reads it
 * as empty or writes over it by accident; `known()` gives the rest, for
 * lists and the name index, which leave its text out.
 */
export class NoteSnap {
  private constructor(
    private readonly snap: DocumentSnapshot,
    private readonly opened: Partial<Record<SealedField, SealedFieldValue>>,
    /** How each text field is stored. */
    readonly storedForms: NoteForms,
    private readonly unreadable?: SealedNoteError,
  ) {}

  /**
   * The forms every write to this note, and every record and hash about
   * it, go by: sealed throughout, always (2026-11-15). Reading goes by
   * `storedForms`.
   */
  readonly forms: NoteForms = SEALED_FORMS;

  /**
   * Opens `snap`'s sealed fields, a list element by element; asks for
   * the key only if one is sealed. Any that does not open locks the
   * note.
   */
  static async open(codec: NoteCodec, snap: DocumentSnapshot): Promise<NoteSnap> {
    const opened: Partial<Record<SealedField, SealedFieldValue>> = {};
    const stored = snap.exists ? snap.data() : undefined;
    const forms = formsFound(stored);
    let unreadable: SealedNoteError | undefined;
    for (const field of SEALED_FIELDS) {
      if (forms[field] !== 'sealed') continue;
      const value = fieldValue(stored, field)!;
      try {
        opened[field] = Array.isArray(value)
          ? await Promise.all(value.map((v) => codec.open(snap.id, field, v)))
          : await codec.open(snap.id, field, value);
      } catch (err) {
        if (!(err instanceof SealedNoteError)) throw err;
        unreadable ??= err;
      }
    }
    return new NoteSnap(snap, opened, forms, unreadable);
  }

  get id(): string {
    return this.snap.id;
  }
  get ref(): DocumentReference {
    return this.snap.ref;
  }
  get exists(): boolean {
    return this.snap.exists;
  }
  /** Sealed, and did not open here. */
  get locked(): boolean {
    return this.unreadable !== undefined;
  }

  /** Field `field` is stored sealed and did not open here. */
  unopened(field: SealedField): boolean {
    return this.storedForms[field] === 'sealed' && !(field in this.opened);
  }

  /** The note with its text opened; throws when it is locked. */
  data(): Data | undefined {
    if (this.unreadable) throw this.unreadable;
    return this.known();
  }

  /**
   * One field; a text field opened, throwing when it did not open. The
   * `source` map comes with its text opened, as `source.text` does.
   */
  get(field: string): unknown {
    if ((SEALED_FIELDS as readonly string[]).includes(field)) {
      const f = field as SealedField;
      if (f in this.opened) return this.opened[f];
      if (this.storedForms[f] === 'sealed') throw this.unreadable;
    }
    if (field === 'source' && this.storedForms['source.text'] === 'sealed') {
      if (this.unopened('source.text')) throw this.unreadable;
      return this.known()?.['source'];
    }
    return this.snap.get(field);
  }

  /** The note with the text that opened, and without the text that did not. */
  known(): Data | undefined {
    const d = this.snap.data();
    if (!d) return undefined;
    let out: Data = { ...d };
    for (const f of SEALED_FIELDS) {
      if (this.storedForms[f] !== 'sealed') continue;
      out = withFieldValue(out, f, this.opened[f]);
    }
    return out;
  }

  /** The note as stored, sealed values as they are. */
  stored(): Data | undefined {
    return this.snap.data();
  }
}

/**
 * Field `field` of a stored note document, as stored: a sealed value as
 * it is, '' when absent. The one raw read of note text outside
 * `NoteSnap`, for a trigger that opens it with `NoteCodec.open` or
 * keeps it as stored on the same note (trigger-boundary.spec.ts).
 */
export function storedText(
  d: Data | undefined,
  field: Exclude<SealedField, SealedListField>,
): string {
  if (field === 'body' || field === 'title') return String(d?.[field] ?? '');
  const value = fieldValue(d, field);
  return typeof value === 'string' ? value : '';
}

/** How each sealed field of `values` is stored, read off the values themselves. */
export function formsOf(values: Record<string, unknown> | undefined): NoteForms {
  return formsFound(values);
}

/**
 * `data` for a write to note `noteId`, each sealed field in it (a list
 * element by element, `source.text` inside its map) sealed under the
 * note's id: every field written is sealed, always (2026-11-15), so no
 * writer can write a sealed field plain. A value sealed already (moved
 * text is opened and sealed again under the new id before it gets
 * here) is refused, as `NoteCodec.seal` refuses it. Every write of note
 * text goes through here.
 *
 * `restored` names the fields that put back writes as they were stored
 * before (`Touched.before`). A sealed value there is written back as it
 * is, never sealed again, once it is shown to open as that field of this
 * note (`NoteCodec.check`), so a value recorded on another note or field
 * is refused; a plain one is sealed.
 */
export async function sealFields(
  codec: NoteCodec,
  noteId: string,
  data: Data,
  restored: ReadonlySet<string> = NONE,
): Promise<Data> {
  let out: Data = { ...data };
  for (const field of SEALED_FIELDS) {
    const value = fieldValue(out, field);
    if (value === undefined) continue;
    const asStored = restored.has(field.split('.')[0]) && isSealedValue(value);
    const one = async (text: string) => {
      if (asStored && isSealed(text)) {
        await codec.check(noteId, field, text);
        return text;
      }
      return codec.seal(noteId, field, text);
    };
    out = withFieldValue(
      out,
      field,
      Array.isArray(value) ? await Promise.all(value.map(one)) : await one(value),
    );
  }
  return out;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The one log line a trigger or callable writes when it leaves a sealed
 * note as stored because it cannot open it: the note id and why, never
 * text or a key.
 */
export function logLeftSealed(
  log: { warn(message: string, fields: Record<string, unknown>): void },
  where: string,
  err: SealedNoteError,
): void {
  log.warn(`${where} left a sealed note as stored: it cannot be opened here`, {
    noteId: err.noteId,
    reason: err.reason,
  });
}

/** A title as an activity entry or summary may hold it: a sealed one is not written out. */
export function shownTitle(title: unknown, form: NoteForm, sealed = SEALED_TITLE): string {
  return form === 'sealed' ? sealed : String(title ?? '');
}
