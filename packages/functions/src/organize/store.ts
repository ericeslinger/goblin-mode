import { Proposal, autoId, paths } from '@mossgoblin/schema';
import { type Firestore, Timestamp } from 'firebase-admin/firestore';
import { randomFillSync } from 'node:crypto';
import {
  type Checked,
  type GardenNote,
  MAX_OPEN,
  PER_ROUND,
  type RawProposal,
  checkProposals,
} from './proposals';
import { type NoteCodec, SEALED_TITLE } from '../mcp/note-text';

const DAY = 86_400_000;
/** A claim this old was cut off partway; the next round says so. */
export const STALE_CLAIM_MS = 3_600_000;
/** Applied and failed proposals are kept this long, then deleted. */
export const KEEP_DONE_DAYS = 90;
const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : 0);

/**
 * Tidies the proposals: one stuck applying (its function stopped) is
 * marked failed, so it does not show as in progress forever; applied
 * and failed ones past KEEP_DONE_DAYS are deleted. Dismissed ones stay,
 * so a dismissed suggestion is never made again.
 */
export async function sweepProposals(db: Firestore, uid: string, now: number): Promise<number> {
  const snap = await db
    .collection(paths.proposals(uid))
    .where('status', 'in', ['applying', 'applied', 'failed'])
    .get();
  const batch = db.batch();
  let n = 0;
  for (const doc of snap.docs) {
    const status = doc.get('status');
    if (status === 'applying' && now - millis(doc.get('claimedAt')) > STALE_CLAIM_MS) {
      batch.update(doc.ref, {
        status: 'failed',
        outcome: 'Stopped partway; check the changes below',
      });
      n++;
    } else if (status !== 'applying' && now - millis(doc.get('createdAt')) > KEEP_DONE_DAYS * DAY) {
      batch.delete(doc.ref);
      n++;
    }
  }
  if (n) await batch.commit();
  return n;
}

/** The garden as the checks see it, read by the caller. */
export interface StoredGarden {
  /** Every note not in Trash, its text opened; one that did not open as archived. */
  notes: GardenNote[];
  /**
   * The notes a record about them is sealed for (`recordForm`, step 3e,
   * 2026-11-13): any field stored sealed. A suggestion about one names
   * it "Sealed note", and its proposed title and reason are sealed. A
   * name proposed for such a concept is not stored at all, since the
   * suggestion's key is built from the names it proposes and would say
   * them in the clear; the names go in with refile.
   */
  sealed: ReadonlySet<string>;
}

/** What a round of suggestions came to. */
export interface Stored {
  /** The suggestions stored, as the gardener will see them. */
  stored: (Checked & { id: string })[];
  /** How many were dropped: already done, made before, or not possible. */
  dropped: number;
  /** How many now wait for the gardener. */
  open: number;
}

/**
 * Stores suggestions for the gardener (#35, through `suggest_changes`):
 * tidies the proposals, checks each suggestion against the garden as it
 * is and every earlier proposal, and stores the survivors as open, up
 * to PER_ROUND at a time and MAX_OPEN waiting. Changes no notes.
 *
 * The garden is the caller's: the MCP tools read it through their note
 * text boundary, so sealed text is opened (2026-11-12). A suggestion
 * about a note in `sealed` (step 3e, 2026-11-13) names it "Sealed
 * note", never its title in the clear, and stores its proposed title
 * and reason sealed under the suggestion's own id (`recordAadFor`),
 * with `codec`; a refile of such a concept keeps its type and leaves
 * out the names proposed for it, which go in with refile. With only
 * plain notes nothing is sealed and the key is never asked for.
 */
export async function storeSuggestions(
  db: Firestore,
  uid: string,
  raw: readonly RawProposal[],
  now: number,
  read: StoredGarden,
  codec: Pick<NoteCodec, 'sealRecord'>,
): Promise<Stored> {
  await sweepProposals(db, uid, now);
  const garden = read.notes;
  const proposals = db.collection(paths.proposals(uid));
  const known = await proposals.select('key', 'status').get();
  const waiting = known.docs.filter((d) => d.get('status') === 'open').length;
  const room = Math.max(0, Math.min(PER_ROUND, MAX_OPEN - waiting));
  const proposed = raw.map((p) =>
    p.kind === 'refile' && p.synonyms?.length && read.sealed.has(p.id)
      ? { ...p, synonyms: undefined }
      : p,
  );
  const checked = checkProposals(
    proposed,
    garden,
    new Set(known.docs.map((d) => String(d.get('key')))),
    room,
  );
  const batch = db.batch();
  const stored: Stored['stored'] = [];
  for (const c of checked) {
    // The id is made here, before its text is sealed under it.
    const id = autoId((bytes) => void randomFillSync(bytes));
    const as = c.notes.some((n) => read.sealed.has(n.id)) ? 'sealed' : 'plain';
    const doc: Checked = {
      ...c,
      notes: c.notes.map((n) => (read.sealed.has(n.id) ? { ...n, title: SEALED_TITLE } : n)),
      reason: await codec.sealRecord('proposals', id, 'reason', c.reason, as),
      ...(c.title === undefined
        ? {}
        : { title: await codec.sealRecord('proposals', id, 'title', c.title, as) }),
    };
    batch.set(
      proposals.doc(id),
      Proposal.parse({ ...doc, status: 'open', createdAt: Timestamp.fromMillis(now) }),
    );
    // As the gardener will see them: titles named as stored, text opened.
    stored.push({ id, ...c, notes: doc.notes });
  }
  await batch.commit();
  return { stored, dropped: raw.length - stored.length, open: waiting + stored.length };
}
