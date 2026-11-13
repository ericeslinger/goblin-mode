import { type Proposal, paths } from '@mossgoblin/schema';
import { type Firestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { NoteCodec } from '../mcp/note-text';
import { dataKeyFor } from '../note-keys/client';
import { type NotesTools, ToolError } from '../mcp/tools';

type Tools = Pick<NotesTools, 'linkNotes' | 'mergeNotes' | 'refile'>;
/** Opens a suggestion's sealed text (step 3e). */
type Records = Pick<NoteCodec, 'openRecord'>;

const RECORDED = { recorded: true } as const;

/**
 * Runs the organize tool a proposal names; returns what it did. The
 * outcome is stored on the proposal, so the titles it quotes are as an
 * activity entry holds them (`recorded`): a sealed one is "Sealed note",
 * never its text in the clear (note encryption, 2026-11-13). A merge's
 * proposed title is opened first, under the proposal's own id (step
 * 3e): one that does not open fails the proposal, saying it is sealed.
 */
async function carryOut(id: string, p: Proposal, tools: Tools, records: Records): Promise<string> {
  const ids = p.notes.map((n) => n.id);
  switch (p.kind) {
    case 'link': {
      const { linked } = await tools.linkNotes({ from: ids[0], to: ids.slice(1) }, RECORDED);
      return linked.length ? `Linked ${linked.map((n) => n.title).join(', ')}` : 'Already linked';
    }
    case 'merge': {
      const title =
        p.title === undefined
          ? undefined
          : await records.openRecord('proposals', id, 'title', p.title);
      const merged = await tools.mergeNotes({ ids, title }, RECORDED);
      return `Merged into ${String(merged.title)}`;
    }
    case 'refile': {
      const { changed, refused } = await tools.refile({
        id: ids[0],
        type: p.conceptType,
        addSynonyms: p.synonyms,
      });
      const done = changed.length ? changed.join('; ') : 'Nothing left to change';
      return refused.length ? `${done}; ${refused.join(', ')} already names another note` : done;
    }
  }
}

/**
 * Applies a proposal the gardener accepted (#35): claims it (so a
 * retried trigger cannot apply it twice), runs the matching organize
 * tool, which records the change in What assistants changed, and stores the
 * outcome. Returns the final status, or undefined if it was not ours.
 */
export async function applyAccepted(
  db: Firestore,
  uid: string,
  id: string,
  tools: Tools,
  now: number,
  /** Opens its sealed text, lazily: with a plain suggestion no key is asked for. */
  records: Records = new NoteCodec(uid, dataKeyFor),
): Promise<'applied' | 'failed' | undefined> {
  const ref = db.doc(`${paths.proposals(uid)}/${id}`);
  const proposal = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.get('status') !== 'accepted') return undefined;
    tx.update(ref, { status: 'applying', claimedAt: Timestamp.fromMillis(now) });
    return doc.data() as Proposal;
  });
  if (!proposal) return undefined;
  try {
    const outcome = await carryOut(id, proposal, tools, records);
    await ref.update({ status: 'applied', outcome });
    return 'applied';
  } catch (err) {
    if (!(err instanceof ToolError)) logger.error('applyAccepted', { id, err });
    const outcome = err instanceof ToolError ? err.message : 'Something went wrong; try again';
    await ref.update({ status: 'failed', outcome });
    return 'failed';
  }
}
