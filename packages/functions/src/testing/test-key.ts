// A gardener's key for specs, and reads of what was written with it
// (always sealed, 2026-11-15): every note text and record about notes
// the functions write is sealed, so a spec that checks what was stored
// opens it first. Plain values pass through as they are, as every
// reader takes them.
import {
  type DataKey,
  SEALED_FIELDS,
  type SealedRecordCollection,
  type SealedRecordField,
  aadFor,
  fieldValue,
  isSealed,
  newDataKey,
  openText,
  recordAadFor,
  withFieldValue,
} from '@mossgoblin/schema';

type Data = Record<string, unknown>;

/** One key for every gardener in a spec run. */
export const TEST_KEY: DataKey = newDataKey();

/** A key source that always answers TEST_KEY, for NotesTools, codecs and stores. */
export const testKeyFor = async (_uid: string): Promise<DataKey> => TEST_KEY;

/**
 * Note `noteId`'s document `d` with each sealed field opened (a list
 * element by element), typed as it came (a snapshot's DocumentData).
 */
export function openedNote<T extends Data>(
  uid: string,
  noteId: string,
  d: T | undefined,
): T | undefined {
  if (!d) return d;
  let out: Data = { ...d };
  for (const field of SEALED_FIELDS) {
    const value = fieldValue(out, field);
    if (value === undefined) continue;
    const one = (v: string) =>
      isSealed(v) ? openText(TEST_KEY, aadFor(uid, noteId, field), v) : v;
    out = withFieldValue(out, field, Array.isArray(value) ? value.map(one) : one(value));
  }
  return out as T;
}

/** Field `field` of record `docId` in `collection`, opened when sealed. */
export function openedRecord<C extends SealedRecordCollection>(
  uid: string,
  collection: C,
  docId: string,
  field: SealedRecordField<C>,
  value: unknown,
): unknown {
  if (typeof value !== 'string' || !isSealed(value)) return value;
  return openText(TEST_KEY, recordAadFor(uid, collection, docId, field), value);
}
