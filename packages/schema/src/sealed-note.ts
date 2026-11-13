// The sealed fields of a note document (note encryption step 3d, Eric,
// 2026-11-13; DESIGN.md, "Note encryption"). `sealed.ts` is the format;
// this says where each sealed field sits in a stored note (or in a
// write to one), whether it is stored sealed, and the one rule for the
// form a write keeps it in. The app and the functions both use it, so
// the rule is stated and built once.
import { SEALED_FIELDS, type SealedField, isSealed, isSealedListField } from './sealed';

type Data = Record<string, unknown>;

/** Whether a field is stored plain or sealed. */
export type NoteForm = 'plain' | 'sealed';
export type NoteForms = Record<SealedField, NoteForm>;

const every = (form: NoteForm) =>
  Object.freeze(Object.fromEntries(SEALED_FIELDS.map((f) => [f, form]))) as NoteForms;
/** Every field plain: a new note, or one with nothing sealed. */
export const PLAIN_FORMS: NoteForms = every('plain');
/** Every field sealed: a new note made from sealed text (DESIGN.md, Preserve the form found). */
export const SEALED_FORMS: NoteForms = every('sealed');

/** A sealed field's value: a string, or for a list field its strings. */
export type SealedFieldValue = string | string[];

/**
 * Field `field` of `data` (a stored note or a write to one), undefined
 * when absent or not text: anything else (a delete sentinel, a number)
 * is not note text. `source.text` is read from a `source` map, or from
 * a dotted `source.text` key in an update; a list keeps only its
 * strings.
 */
export function fieldValue(
  data: Data | undefined,
  field: SealedField,
): SealedFieldValue | undefined {
  if (!data) return undefined;
  if (field === 'source.text') {
    const source = data['source'];
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      const text = (source as Data)['text'];
      return typeof text === 'string' ? text : undefined;
    }
    const dotted = data['source.text'];
    return typeof dotted === 'string' ? dotted : undefined;
  }
  const value = data[field];
  if (isSealedListField(field)) {
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * `data` with field `field` set to `value`, or taken out when `value` is
 * undefined; a copy, `data` left as it is. `source.text` goes where it
 * was read from: into a copy of the `source` map, or the dotted key.
 */
export function withFieldValue(
  data: Data,
  field: SealedField,
  value: SealedFieldValue | undefined,
): Data {
  const out: Data = { ...data };
  if (field === 'source.text') {
    const source = out['source'];
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      const next: Data = { ...(source as Data) };
      if (value === undefined) delete next['text'];
      else next['text'] = value;
      out['source'] = next;
    } else if (value === undefined) delete out['source.text'];
    else out['source.text'] = value;
    return out;
  }
  if (value === undefined) delete out[field];
  else out[field] = value;
  return out;
}

/** Whether `value` is stored sealed: a list is when any element is. */
export function isSealedValue(value: SealedFieldValue | undefined): boolean {
  return Array.isArray(value) ? value.some(isSealed) : isSealed(value);
}

/** How each sealed field of `data` is stored, read off the values themselves. */
export function formsFound(data: Data | undefined): NoteForms {
  return Object.fromEntries(
    SEALED_FIELDS.map((f) => [f, isSealedValue(fieldValue(data, f)) ? 'sealed' : 'plain']),
  ) as NoteForms;
}

/** Whether any sealed field of a note is stored sealed. */
export function anySealed(forms: NoteForms): boolean {
  return SEALED_FIELDS.some((f) => forms[f] === 'sealed');
}

/**
 * The form a write puts each field in, given the forms found on the
 * note (or `formFrom` its sources, for a new one). The one rule, for
 * the app and the functions alike:
 *
 * - A field is written in the form it was found in. Nothing starts
 *   sealing a field that was plain (readers before writers).
 * - No field is plainer than the body (review on #263, widened
 *   2026-11-13): a title made from the body's first words would say
 *   them in the clear, and the other fields beside a sealed body are
 *   sealed with it, so a sealed note is sealed throughout.
 * - The other names are never plainer than the title: a concept's
 *   rename keeps its old title among them.
 */
export function writtenForms(found: NoteForms): NoteForms {
  const out = { ...found };
  if (found.body === 'sealed') for (const f of SEALED_FIELDS) out[f] = 'sealed';
  if (found.title === 'sealed') out.synonyms = 'sealed';
  return out;
}
