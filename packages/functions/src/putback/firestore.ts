// Put back (#154 step 1) over Firestore: reads the run, its notes and
// the texts its writes replaced, and writes the put back with its own
// record in one transaction (DESIGN.md, Trust, step 1).
import { parseNote, wikiLinkTargets } from '@mossgoblin/editor/grammar';
import {
  Activity,
  type FieldBefore,
  GARDEN_AGENT,
  Note,
  PUT_BACK_TOOL,
  agentOf,
  canPutBack,
  nameIndex,
  paths,
  putBackDepth,
  putBackId,
  resolveLinks,
  textHash,
} from '@mossgoblin/schema';
import {
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { agentDevice } from '../mcp/tools';
import {
  type NoteFacts,
  type RunFacts,
  nothingToPutBack,
  planPutBack,
  putBackSummary,
} from './plan';

/** Put backs a day, like the other things the app asks the server to do. */
export const DAILY_PUT_BACKS = 50;
/** How many kept versions to search for the text a run wrote over. */
export const VERSIONS_SEARCHED = 50;

export type RefusedCode =
  'invalid-argument' | 'not-found' | 'failed-precondition' | 'resource-exhausted';

/** A put back refused, with why, for the callable to pass on. */
export class PutBackRefused extends Error {
  constructor(
    readonly code: RefusedCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PutBackResult {
  /** 'already': this run was put back before; nothing was written. */
  status: 'done' | 'already';
  /** The put back's own activity record. */
  id: string;
  /** How many notes it wrote. */
  notes: number;
}

const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined);

/** The deviceId a put back's note writes carry: its own, so History keeps what it replaced. */
export function putBackDevice(recordId: string): string {
  return `${agentDevice(GARDEN_AGENT)}~${recordId}`;
}

function runFacts(id: string, d: Record<string, unknown>): RunFacts {
  const tool = String(d['tool'] ?? '');
  return {
    id,
    at: millis(d['at']) ?? 0,
    tool,
    summary: String(d['summary'] ?? ''),
    device: tool === PUT_BACK_TOOL ? putBackDevice(id) : agentDevice(agentOf(d)),
    notes: Array.isArray(d['notes'])
      ? d['notes'].map(
          (t: { id?: unknown; title?: unknown; made?: unknown; before?: unknown }) => ({
            id: String(t.id ?? ''),
            title: String(t.title ?? ''),
            ...(t.made === true ? { made: true } : {}),
            ...(t.before && typeof t.before === 'object'
              ? { before: t.before as Record<string, FieldBefore> }
              : {}),
          }),
        )
      : [],
  };
}

function noteFacts(snap: DocumentSnapshot): NoteFacts | undefined {
  if (!snap.exists) return undefined;
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    body: String(d['body'] ?? ''),
    title: String(d['title'] ?? ''),
    ...(typeof d['titleSource'] === 'string' ? { titleSource: d['titleSource'] } : {}),
    archived: d['archived'] === true,
    ...(typeof d['mergedInto'] === 'string' ? { mergedInto: d['mergedInto'] } : {}),
    updatedAt: millis(d['updatedAt']),
    deviceId: String(d['deviceId'] ?? ''),
    ...(typeof d['baseHash'] === 'string' && d['baseHash'] ? { baseHash: d['baseHash'] } : {}),
    fields: d,
  };
}

/**
 * Puts back activity run `runId` of gardener `uid`: the notes it wrote
 * go back to the text they had before it, notes it archived come back,
 * a merge's originals come back and the merged note is archived, a
 * note it made is archived (never deleted), and the fields a filing or
 * a finished queue item changed get the values its record kept (#206).
 * Recorded as a run of its own, id `putBackId(runId)`, so it shows in
 * What assistants changed and can be put back in turn.
 */
export async function putBack(
  db: Firestore,
  uid: string,
  runId: string,
  now: number = Date.now(),
): Promise<PutBackResult> {
  if (!runId || runId.includes('/')) throw new PutBackRefused('invalid-argument', 'Which run?');
  const recordId = putBackId(runId);
  // Names only, for the links of a text put back; read before the transaction.
  const named = await db
    .collection(paths.notes(uid))
    .select('title', 'kind', 'synonyms', 'archived')
    .get();
  const index = nameIndex(
    named.docs.map((d) => ({
      id: d.id,
      title: String(d.get('title') ?? ''),
      kind: typeof d.get('kind') === 'string' ? d.get('kind') : 'text',
      synonyms: Array.isArray(d.get('synonyms')) ? d.get('synonyms').map(String) : undefined,
      archived: d.get('archived') === true,
    })),
  );
  const activity = db.collection(paths.activity(uid));
  const usageRef = db.doc(paths.usage(uid, new Date(now).toISOString().slice(0, 10)));
  return db.runTransaction(async (tx) => {
    const [runDoc, doneDoc, usage] = await tx.getAll(
      activity.doc(runId),
      activity.doc(recordId),
      usageRef,
    );
    if (!runDoc.exists) throw new PutBackRefused('not-found', 'No such change.');
    if (doneDoc.exists) return { status: 'already', id: recordId, notes: 0 };
    const run = runFacts(runId, runDoc.data()!);
    const { base: baseId, depth } = putBackDepth(runId);
    const baseDoc = depth ? await tx.get(activity.doc(baseId)) : runDoc;
    if (!baseDoc.exists) throw new PutBackRefused('not-found', 'The change it put back is gone.');
    const base = depth ? runFacts(baseId, baseDoc.data()!) : run;
    if (!canPutBack(run) || !canPutBack(base))
      throw new PutBackRefused('failed-precondition', 'History cannot put this change back.');

    const ids = [...new Set([...base.notes, ...run.notes].map((t) => t.id))].filter(Boolean);
    const snaps = ids.length
      ? await tx.getAll(...ids.map((id) => db.doc(paths.note(uid, id))))
      : [];
    const notes = new Map<string, NoteFacts>();
    for (const s of snaps) {
      const n = noteFacts(s);
      if (n) notes.set(n.id, n);
    }
    // The text each of the run's notes was written over, by its hash:
    // the replaced texts first (every one, for two days), then History.
    const textBefore = new Map<string, string>();
    for (const t of run.notes) {
      const hash = notes.get(t.id)?.baseHash;
      if (!hash) continue;
      const replaced = await tx.get(db.doc(`${paths.replaced(uid, t.id)}/${hash}`));
      const body = replaced.get('body');
      if (typeof body === 'string' && textHash(body) === hash) {
        textBefore.set(t.id, body);
        continue;
      }
      const kept = await tx.get(
        db.collection(paths.history(uid, t.id)).orderBy('savedAt', 'desc').limit(VERSIONS_SEARCHED),
      );
      const match = kept.docs
        .map((d) => d.get('body'))
        .find((b): b is string => typeof b === 'string' && textHash(b) === hash);
      if (match !== undefined) textBefore.set(t.id, match);
    }

    const plan = planPutBack({ run, base, depth, notes, textBefore });
    if (!plan.writes.length)
      throw new PutBackRefused('failed-precondition', nothingToPutBack(plan));
    const used = Number(usage.get('putBacks') ?? 0);
    if (used >= DAILY_PUT_BACKS) {
      throw new PutBackRefused(
        'resource-exhausted',
        `Today’s ${DAILY_PUT_BACKS} put backs are used up; try again tomorrow.`,
      );
    }

    const stamp = {
      updatedAt: Timestamp.fromMillis(now),
      updatedBy: 'claude' as const,
      agent: GARDEN_AGENT,
      deviceId: putBackDevice(recordId),
    };
    for (const w of plan.writes) {
      const current = snaps.find((s) => s.id === w.id)!.data()!;
      const note = notes.get(w.id)!;
      const update: Record<string, unknown> = {
        ...stamp,
        // Every put back says what it wrote over, so putting it back
        // finds that text, and a flip alone names the text it kept.
        baseHash: textHash(note.body),
      };
      if (w.archived !== undefined) update['archived'] = w.archived;
      if (w.body !== undefined) {
        update['body'] = w.body;
        update['links'] = resolveLinks(wikiLinkTargets(parseNote(w.body)), index);
      }
      if (w.newTitle !== undefined) update['title'] = w.newTitle;
      const next = { ...current, ...update };
      if (w.mergedInto === null) delete next['mergedInto'];
      else if (w.mergedInto !== undefined) update['mergedInto'] = next['mergedInto'] = w.mergedInto;
      // Fields a filing or a finished queue item changed (#206): null was absent.
      const gone: string[] = [];
      for (const [k, v] of Object.entries(w.fields ?? {})) {
        if (v === null) {
          delete next[k];
          gone.push(k);
        } else update[k] = next[k] = v;
      }
      Note.parse(next);
      if (w.mergedInto === null) update['mergedInto'] = FieldValue.delete();
      for (const k of gone) update[k] = FieldValue.delete();
      tx.update(db.doc(paths.note(uid, w.id)), update);
    }
    tx.set(
      activity.doc(recordId),
      Activity.parse({
        at: Timestamp.fromMillis(now),
        tool: PUT_BACK_TOOL,
        summary: putBackSummary(run, plan),
        notes: plan.writes.map((w) => ({
          id: w.id,
          title: w.title,
          ...(w.before ? { before: w.before } : {}),
        })),
        reminders: [],
        agent: GARDEN_AGENT,
      }),
    );
    tx.set(usageRef, { putBacks: used + 1 }, { merge: true });
    return { status: 'done', id: recordId, notes: plan.writes.length };
  });
}
