// What itemAssigned does with one note write (#144 step 4), over a
// Firestore and a codec, so specs run it without the trigger. A sealed
// body is opened with the event's one codec (note encryption step 3c,
// 2026-11-13); one that cannot be opened here starts nothing, is left
// as stored, and its next settle looks again. Nothing here throws for a
// sealed note, and the trigger sets no `retry`, so it never loops.
//
// A run's item text and key are the note's words, so they are stored
// sealed when the note is (`recordForm`, step 3e, 2026-11-13), under the
// run's own id. That id is a hash of the item's key, made before the
// text is sealed under it: a hash site, left for the keyed hashes.
import { RUN_STALE_MS, assignedItems, formsFound, paths, recordForm } from '@mossgoblin/schema';
import { type Firestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { type NoteCodec, SealedNoteError, logLeftSealed, storedText } from '../mcp/note-text';
import { itemRunId } from './items';

const ms = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined);

/**
 * When a note settles, each unticked item ending in @goblin that has no
 * run yet gets one; returns how many started, or 'sealed'. The run id is
 * the note's and the item's, so a later settle, or an edit elsewhere in
 * the note, never starts it twice.
 */
export async function assignedOnWrite(
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  noteId: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  now: number,
  log: { warn(message: string, fields: Record<string, unknown>): void },
): Promise<number | 'sealed'> {
  if (!after || after['archived'] === true || after['deletedAt'] !== undefined) return 0;
  if (ms(after['settledAt']) === undefined || ms(after['settledAt']) === ms(before?.['settledAt']))
    return 0;
  let body: string;
  try {
    body = await codec.open(noteId, 'body', storedText(after, 'body'));
  } catch (err) {
    if (!(err instanceof SealedNoteError)) throw err;
    logLeftSealed(log, 'itemAssigned', err);
    return 'sealed';
  }
  const items = assignedItems(body).filter((i) => !i.done);
  const as = recordForm(formsFound(after));
  let started = 0;
  for (const item of items) {
    const runId = itemRunId(noteId, item.key);
    const ref = db.doc(paths.run(uid, runId));
    // Sealed before the transaction, which may run more than once.
    const itemText = await codec.sealRecord('runs', runId, 'itemText', item.text, as);
    const itemKey = await codec.sealRecord('runs', runId, 'itemKey', item.key, as);
    const made = await db.runTransaction(async (tx) => {
      const had = (await tx.get(ref)).data();
      if (had) {
        // Started again only when it failed for a reason a later settle
        // can mend, or was lost with its function (review on #158).
        const since = had['startedAt'] ?? had['createdAt'];
        const age = since instanceof Timestamp ? now - since.toMillis() : Infinity;
        const lost =
          (had['status'] === 'requested' || had['status'] === 'working') && age > RUN_STALE_MS;
        const mendable = had['status'] === 'failed' && had['retryable'] === true;
        if (!lost && !mendable) return false;
      }
      tx.set(ref, {
        kind: 'item',
        noteId,
        itemText,
        itemKey,
        status: 'requested',
        attempt: (typeof had?.['attempt'] === 'number' ? had['attempt'] : 0) + 1,
        steps: [],
        createdAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (made) started++;
  }
  return started;
}
