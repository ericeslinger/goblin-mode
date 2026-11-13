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
import {
  type DataKey,
  SEALED_FIELDS,
  SealError,
  type SealedField,
  aadFor,
  isSealed,
  openText,
  sealText,
} from '@mossgoblin/schema';
import type { DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import { ToolError } from './tool-error';

type Data = Record<string, unknown>;

/** Whether a field is stored plain or sealed. */
export type NoteForm = 'plain' | 'sealed';
export type NoteForms = Record<SealedField, NoteForm>;
export const PLAIN: NoteForms = Object.freeze({ body: 'plain', title: 'plain' });

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
    private readonly opened: Partial<Record<SealedField, string>>,
    /** How each text field is stored. */
    readonly forms: NoteForms,
    private readonly unreadable?: SealedNoteError,
  ) {}

  /** Opens `snap`'s body and title; asks for the key only if one is sealed. */
  static async open(codec: NoteCodec, snap: DocumentSnapshot): Promise<NoteSnap> {
    const opened: Partial<Record<SealedField, string>> = {};
    const forms: NoteForms = { ...PLAIN };
    let unreadable: SealedNoteError | undefined;
    for (const field of SEALED_FIELDS) {
      const value: unknown = snap.exists ? snap.get(field) : undefined;
      if (!isSealed(value)) continue;
      forms[field] = 'sealed';
      try {
        opened[field] = await codec.open(snap.id, field, value);
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
    return SEALED_FIELDS.some((f) => this.forms[f] === 'sealed');
  }

  /** The note with its text opened; throws when it is locked. */
  data(): Data | undefined {
    if (this.unreadable) throw this.unreadable;
    return this.known();
  }

  /** One field; a text field opened, throwing when it did not open. */
  get(field: string): unknown {
    if ((SEALED_FIELDS as readonly string[]).includes(field)) {
      const f = field as SealedField;
      if (f in this.opened) return this.opened[f];
      if (this.forms[f] === 'sealed') throw this.unreadable;
    }
    return this.snap.get(field);
  }

  /** The note with the text that opened, and without the text that did not. */
  known(): Data | undefined {
    const d = this.snap.data();
    if (!d) return undefined;
    const out: Data = { ...d, ...this.opened };
    for (const f of SEALED_FIELDS)
      if (this.forms[f] === 'sealed' && !(f in this.opened)) delete out[f];
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
  return sources.some((s) => s?.sealed) ? { body: 'sealed', title: 'sealed' } : PLAIN;
}

/**
 * Field `field` of a stored note document, as stored: a sealed value as
 * it is, '' when absent. The one raw read of note text outside
 * `NoteSnap`, for a trigger that opens it with `NoteCodec.open` or
 * keeps it as stored on the same note (trigger-boundary.spec.ts).
 */
export function storedText(d: Data | undefined, field: SealedField): string {
  return String(d?.[field] ?? '');
}

/** How `values`' body and title are stored, read off the values themselves. */
export function formsOf(values: { body?: unknown; title?: unknown } | undefined): NoteForms {
  return {
    body: isSealed(values?.body) ? 'sealed' : 'plain',
    title: isSealed(values?.title) ? 'sealed' : 'plain',
  };
}

/**
 * `data` for a write to note `noteId`, a `body` or `title` in it stored
 * as `forms` says: the note's own forms when it rewrites a note, PLAIN
 * or `formFrom` its sources for a new one. A title is never plainer than
 * its body (review on #263): one made from the body's first words would
 * say them in the clear. Every write of note text goes through here.
 */
export async function sealFields(
  codec: NoteCodec,
  noteId: string,
  data: Data,
  forms: NoteForms,
): Promise<Data> {
  const out: Data = { ...data };
  const as: NoteForms = forms.body === 'sealed' ? { ...forms, title: 'sealed' } : forms;
  for (const field of SEALED_FIELDS) {
    const value = out[field];
    if (typeof value === 'string') out[field] = await codec.seal(noteId, field, value, as[field]);
  }
  return out;
}

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
