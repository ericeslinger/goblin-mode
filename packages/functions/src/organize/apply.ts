import { type Proposal, paths } from '@mossgoblin/schema';
import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { type NotesTools, ToolError } from '../mcp/tools';

type Tools = Pick<NotesTools, 'linkNotes' | 'mergeNotes' | 'refile'>;

/** Runs the organize tool a proposal names; returns what it did. */
async function carryOut(p: Proposal, tools: Tools): Promise<string> {
  const ids = p.notes.map((n) => n.id);
  switch (p.kind) {
    case 'link': {
      const { linked } = await tools.linkNotes({ from: ids[0], to: ids.slice(1) });
      return linked.length ? `Linked ${linked.map((n) => n.title).join(', ')}` : 'Already linked';
    }
    case 'merge': {
      const merged = await tools.mergeNotes({ ids, title: p.title });
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
 * tool, which records the change in What Claude changed, and stores the
 * outcome. Returns the final status, or undefined if it was not ours.
 */
export async function applyAccepted(
  db: Firestore,
  uid: string,
  id: string,
  tools: Tools,
): Promise<'applied' | 'failed' | undefined> {
  const ref = db.doc(`${paths.proposals(uid)}/${id}`);
  const proposal = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.get('status') !== 'accepted') return undefined;
    tx.update(ref, { status: 'applying' });
    return doc.data() as Proposal;
  });
  if (!proposal) return undefined;
  try {
    const outcome = await carryOut(proposal, tools);
    await ref.update({ status: 'applied', outcome });
    return 'applied';
  } catch (err) {
    if (!(err instanceof ToolError)) logger.error('applyAccepted', { id, err });
    const outcome = err instanceof ToolError ? err.message : 'Something went wrong; try again';
    await ref.update({ status: 'failed', outcome });
    return 'failed';
  }
}
