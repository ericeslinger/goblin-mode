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
import { SEALED_TITLE } from '../mcp/note-text';

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
  /** The notes whose title is stored sealed. */
  sealedTitles: ReadonlySet<string>;
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
 * text boundary, so sealed text is opened (2026-11-12). A title in
 * `sealedTitles` is stored in a proposal as "Sealed note", never in
 * the clear.
 */
export async function storeSuggestions(
  db: Firestore,
  uid: string,
  raw: readonly RawProposal[],
  now: number,
  read: StoredGarden,
): Promise<Stored> {
  await sweepProposals(db, uid, now);
  const garden = read.notes;
  const proposals = db.collection(paths.proposals(uid));
  const known = await proposals.select('key', 'status').get();
  const waiting = known.docs.filter((d) => d.get('status') === 'open').length;
  const room = Math.max(0, Math.min(PER_ROUND, MAX_OPEN - waiting));
  const checked = checkProposals(
    raw,
    garden,
    new Set(known.docs.map((d) => String(d.get('key')))),
    room,
  );
  const batch = db.batch();
  const shown = (c: Checked): Checked => ({
    ...c,
    notes: c.notes.map((n) => (read.sealedTitles.has(n.id) ? { ...n, title: SEALED_TITLE } : n)),
  });
  const stored = checked.map(shown).map((c) => {
    const id = autoId((bytes) => void randomFillSync(bytes));
    batch.set(
      proposals.doc(id),
      Proposal.parse({ ...c, status: 'open', createdAt: Timestamp.fromMillis(now) }),
    );
    return { id, ...c };
  });
  await batch.commit();
  return { stored, dropped: raw.length - stored.length, open: waiting + stored.length };
}
