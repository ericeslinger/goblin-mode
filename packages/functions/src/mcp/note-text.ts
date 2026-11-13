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
// (SEALED_FIELDS). The form a write keeps is `writtenForms`, shared with
// the app (packages/schema/src/sealed-note.ts).
import {
  type DataKey,
  type NoteForm,
  type NoteForms,
  PLAIN_FORMS,
  SEALED_FIELDS,
  SEALED_FORMS,
  SealError,
  type SealedField,
  type SealedFieldValue,
  type SealedListField,
  aadFor,
  anySealed,
  fieldValue,
  formsFound,
  isSealed,
  isSealedValue,
  openText,
  sealText,
  withFieldValue,
  writtenForms,
} from '@mossgoblin/schema';
import type { DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import { ToolError } from './tool-error';

type Data = Record<string, unknown>;

export type { NoteForm, NoteForms };
/** Every field plain: a new note, or one with nothing sealed. */
export const PLAIN: NoteForms = PLAIN_FORMS;

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

/** One gardener's opener and sealer, for one request. */
export class NoteCodec {
  private key?: Promise<DataKey>;

  constructor(
    private readonly uid: string,
    private readonly keyFor: KeyFor,
  ) {}

  /** The key, asked for once; a failed ask stays failed for this codec. */
  private dataKey(noteId: string): Promise<DataKey> {
    if (!this.key) {
      this.key = this.keyFor(this.uid);
      this.key.catch((err: unknown) => {
        // The client's errors name the failure, never a key or secret.
        const why = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown';
        console.warn(`note key not available, sealed notes left closed (${why})`);
      });
    }
    return this.key.catch(() => {
      throw new SealedNoteError(noteId, 'no-key');
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
   * note's id when `as` is 'sealed', else as it is. Text that would read
   * as a sealed value is refused either way: stored plain it would lock
   * the note, and sealing it is refused by the library.
   */
  async seal(noteId: string, field: SealedField, text: string, as: NoteForm): Promise<string> {
    if (isSealed(text)) {
      throw new ToolError(`the ${field} cannot start with the sealed-text marker (U+E000 mg)`);
    }
    if (as === 'plain') return text;
    const key = await this.dataKey(noteId);
    return sealText(key, aadFor(this.uid, noteId, field), text);
  }
}

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
    readonly forms: NoteForms,
    private readonly unreadable?: SealedNoteError,
  ) {}

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
  /** Any text field is stored sealed (opened or not). */
  get sealed(): boolean {
    return anySealed(this.forms);
  }

  /** Field `field` is stored sealed and did not open here. */
  unopened(field: SealedField): boolean {
    return this.forms[field] === 'sealed' && !(field in this.opened);
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
      if (this.forms[f] === 'sealed') throw this.unreadable;
    }
    if (field === 'source' && this.forms['source.text'] === 'sealed') {
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
      if (this.forms[f] !== 'sealed') continue;
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
 * The form a new note made from others' text takes (2026-11-12): sealed,
 * both fields, if any field of any source is sealed, so moved text is
 * never written out in the clear; else plain. Each source's text is
 * opened under its own id and sealed again under the new note's.
 */
export function formFrom(sources: readonly (NoteSnap | undefined)[]): NoteForms {
  return sources.some((s) => s?.sealed) ? SEALED_FORMS : PLAIN;
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
 * element by element, `source.text` inside its map) stored as
 * `writtenForms(forms)` says: `forms` is the note's own when it
 * rewrites a note, PLAIN or `formFrom` its sources for a new one. So a
 * field keeps the form it was found in, and no field is plainer than a
 * sealed body (sealed-note.ts, the one rule). Every write of note text
 * goes through here.
 *
 * `restored` names the fields that put back writes as they were stored
 * before (`Touched.before`). A sealed value there is written back as it
 * is, never sealed again, once it is shown to open as that field of this
 * note (`NoteCodec.check`), so a value recorded on another note or field
 * is refused; a plain one is written in the form the rule gives.
 */
export async function sealFields(
  codec: NoteCodec,
  noteId: string,
  data: Data,
  forms: NoteForms,
  restored: ReadonlySet<string> = NONE,
): Promise<Data> {
  let out: Data = { ...data };
  const as = writtenForms(forms);
  for (const field of SEALED_FIELDS) {
    const value = fieldValue(out, field);
    if (value === undefined) continue;
    const asStored = restored.has(field.split('.')[0]) && isSealedValue(value);
    const one = async (text: string) => {
      if (asStored && isSealed(text)) {
        await codec.check(noteId, field, text);
        return text;
      }
      return codec.seal(noteId, field, text, as[field]);
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
