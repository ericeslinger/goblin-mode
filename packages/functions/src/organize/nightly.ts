import { Proposal, autoId, paths } from '@mossgoblin/schema';
import { type Firestore, Timestamp } from 'firebase-admin/firestore';
import { randomFillSync } from 'node:crypto';
import { RECENT_DAYS, type Proposer } from './claude-proposer';
import { type GardenNote, MAX_OPEN, PER_NIGHT, checkProposals } from './proposals';

const DAY = 86_400_000;
/** A claim this old was cut off partway; the run says so. */
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

/**
 * One night's organize pass (#35): tidy the proposals; then, when notes
 * changed in the last week and there is room, ask for suggestions, keep
 * the ones that check out, and store them as open proposals. Changes no
 * notes.
 */
export async function organizeNightly(
  db: Firestore,
  uid: string,
  propose: Proposer,
  now: number,
): Promise<{ recent: number; asked: boolean; added: number }> {
  await sweepProposals(db, uid, now);
  const snap = await db.collection(paths.notes(uid)).get();
  const notes = snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      kind: String(d['kind'] ?? 'text'),
      title: String(d['title'] ?? ''),
      body: String(d['body'] ?? ''),
      synonyms: Array.isArray(d['synonyms']) ? d['synonyms'].map(String) : undefined,
      conceptType: typeof d['conceptType'] === 'string' ? d['conceptType'] : undefined,
      archived: d['archived'] === true,
      at: millis(d['updatedAt']),
    };
  });
  const garden: GardenNote[] = notes;
  const recent = notes
    .filter((n) => !n.archived && n.body.trim() && n.at >= now - RECENT_DAYS * DAY)
    .sort((a, b) => b.at - a.at);
  if (recent.length === 0) return { recent: 0, asked: false, added: 0 };

  const proposals = db.collection(paths.proposals(uid));
  const known = await proposals.select('key', 'status').get();
  const open = known.docs.filter((d) => d.get('status') === 'open').length;
  const room = Math.min(PER_NIGHT, MAX_OPEN - open);
  if (room <= 0) return { recent: recent.length, asked: false, added: 0 };

  const raw = await propose(garden, recent);
  const checked = checkProposals(
    raw,
    garden,
    new Set(known.docs.map((d) => String(d.get('key')))),
    room,
  );
  const batch = db.batch();
  for (const c of checked) {
    const id = autoId((bytes) => void randomFillSync(bytes));
    batch.set(
      proposals.doc(id),
      Proposal.parse({ ...c, status: 'open', createdAt: Timestamp.fromMillis(now) }),
    );
  }
  await batch.commit();
  return { recent: recent.length, asked: true, added: checked.length };
}
