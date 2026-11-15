import {
  type DataKey,
  SEALED_FIELDS,
  aadFor,
  fieldValue,
  isSealed,
  newDataKey,
  openText,
  withFieldValue,
} from '@mossgoblin/schema';

/**
 * A gardener's note key for specs (always sealed, 2026-11-15): every
 * note text the app writes is sealed with it, so a spec that checks what
 * was written opens it first with `openedWrite`.
 */
export const TEST_NOTE_KEY: DataKey = newDataKey();

/**
 * `data`, a write to the note document at `path` (`users/{uid}/notes/{id}`),
 * with each sealed field opened, a list element by element; plain values
 * as they are. Anything not a note document is given back unchanged.
 */
export function openedWrite(
  path: string,
  data: Record<string, unknown>,
  key: DataKey = TEST_NOTE_KEY,
): Record<string, unknown> {
  const m = /^users\/([^/]+)\/notes\/([^/]+)$/.exec(path);
  if (!m) return data;
  const [, uid, id] = m;
  let out = data;
  for (const field of SEALED_FIELDS) {
    const value = fieldValue(out, field);
    if (value === undefined) continue;
    const one = (v: string) => (isSealed(v) ? openText(key, aadFor(uid, id, field), v) : v);
    out = withFieldValue(out, field, Array.isArray(value) ? value.map(one) : one(value));
  }
  return out;
}
