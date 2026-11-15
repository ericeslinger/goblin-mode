// The `sealEverything` callable (note encryption, the migration, Eric,
// 2026-11-15; DESIGN.md, "Note encryption", The migration): Settings'
// Seal everything now. One call does the whole pass on the server, as
// far as its time allows, and answers a cursor only when it ran out of
// time; the app calls again with it. A dry run counts and writes
// nothing. Every write stands on its own (a transaction that leaves a
// document sealed or as it was), so a call cut off, or a phone that
// went away mid-call, leaves nothing half done, and calling again
// carries on: a value sealed already is skipped.
//
// It runs as the default compute account, the one `mcp`, `noteHistory`,
// `proposalAccepted` and put back run as: it is on the Worker's
// `NOTE_KEY_CALLERS`, and `checkNoteKey` proved it gets the gardener's
// key when the switch was turned on. It needs nothing the other two
// accounts hold (no Anthropic federation, no gardener's model key).
import { randomBytes } from 'node:crypto';
import { SEAL_KINDS, type SealCursor, type SealPass, type DataKey } from '@mossgoblin/schema';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { NoteCodec, sealingIn } from '../mcp/note-text';
import { KeyCheckRefused, keyCheck } from '../note-keys/check';
import { dataKeyFor, freshDataKeyFor } from '../note-keys/client';
import { SealingTurnedOff, sealAllPass } from './seal-all';

/** The callable's time limit: the most a Functions v2 callable may have. */
export const SEAL_TIMEOUT_S = 3600;
/** No new page is started after this much of it, so a page in hand finishes in time. */
export const SEAL_BUDGET_MS = (SEAL_TIMEOUT_S - 300) * 1000;

/** Why nothing was done, in words the app shows. */
export class SealAllRefused extends Error {
  override readonly name = 'SealAllRefused';
  constructor(
    readonly code: 'invalid-argument' | 'failed-precondition' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

/** The request as the app sends it, or a refusal. */
export function sealRequestOf(data: unknown): { dryRun: boolean; cursor?: SealCursor } {
  const d = (data ?? {}) as { dryRun?: unknown; cursor?: unknown };
  if (typeof d.dryRun !== 'boolean') throw new SealAllRefused('invalid-argument', 'Which pass?');
  if (d.cursor === undefined || d.cursor === null) return { dryRun: d.dryRun };
  const c = d.cursor as { kind?: unknown; after?: unknown };
  const kind = SEAL_KINDS.find((k) => k === c.kind);
  // A document id: no slash, no more than Firestore's 1500 bytes, not
  // `.` or `..` (review on #277: a slash made Firestore throw).
  const id = (a: unknown): a is string =>
    typeof a === 'string' &&
    a !== '' &&
    a !== '.' &&
    a !== '..' &&
    !a.includes('/') &&
    new TextEncoder().encode(a).length <= 1500;
  if (!kind || (c.after !== undefined && !id(c.after))) {
    throw new SealAllRefused(
      'invalid-argument',
      'That place to go on from is not one this pass gave, so nothing was done. Start again.',
    );
  }
  return {
    dryRun: d.dryRun,
    cursor: { kind, ...(typeof c.after === 'string' ? { after: c.after } : {}) },
  };
}

/**
 * One pass for gardener `uid`, from `cursor`. Refuses unless the
 * gardener's switch is on and the key can be fetched now, the same
 * fetch the switch's check makes (`keyCheck`, afresh past the
 * instance's kept key: `checkKeyFor`), so nothing is sealed by a server
 * that could not open it again. The pass itself then uses the key the
 * normal way (`keyFor`, kept for the instance), asked for once.
 */
export async function sealEverythingFor(
  db: Firestore,
  uid: string,
  request: { dryRun: boolean; cursor?: SealCursor },
  start: number,
  keyFor: (uid: string) => Promise<DataKey> = dataKeyFor,
  budgetMs = SEAL_BUDGET_MS,
  now: () => number = Date.now,
  checkKeyFor: (uid: string) => Promise<DataKey> = freshDataKeyFor,
): Promise<SealPass> {
  const switched = sealingIn(db, uid);
  if (!(await switched())) {
    throw new SealAllRefused(
      'failed-precondition',
      'Sealing is off, so nothing was sealed. Turn it on first.',
    );
  }
  try {
    await keyCheck(uid, randomBytes(24).toString('base64url'), checkKeyFor);
  } catch (err) {
    if (!(err instanceof KeyCheckRefused)) throw err;
    throw new SealAllRefused(
      err.code === 'invalid-argument' ? 'unavailable' : err.code,
      `${err.message} Nothing was sealed.`,
    );
  }
  try {
    return await sealAllPass(
      {
        db,
        codec: new NoteCodec(uid, keyFor, sealingIn(db, uid)),
        uid,
        dryRun: request.dryRun,
        deadline: start + budgetMs,
        now,
        stillOn: switched,
      },
      request.cursor,
    );
  } catch (err) {
    if (err instanceof SealingTurnedOff) {
      throw new SealAllRefused(
        'failed-precondition',
        'Sealing was turned off, so the pass stopped. What it sealed stays sealed.',
      );
    }
    throw err;
  }
}

/** Seal everything now: signed in only, the caller's own garden only. */
export const sealEverything = onCall(
  // A gibibyte: four documents near 1 MiB at once, sealed, and what an
  // entry reads of History (review on #277).
  { timeoutSeconds: SEAL_TIMEOUT_S, memory: '1GiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    try {
      const pass = await sealEverythingFor(
        getFirestore(),
        request.auth.uid,
        sealRequestOf(request.data),
        Date.now(),
      );
      // Counts only: no text, no ids.
      logger.info('sealEverything', { done: pass.done, ...pass.report });
      return pass;
    } catch (err) {
      if (err instanceof SealAllRefused) throw new HttpsError(err.code, err.message);
      throw err;
    }
  },
);
