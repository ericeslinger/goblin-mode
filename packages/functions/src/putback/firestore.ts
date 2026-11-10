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
  REROUTE_TOOL,
  agentOf,
  canPutBack,
  moduleOn,
  nameIndex,
  paths,
  putBackDepth,
  putBackId,
  rerouteId,
  rerouteNotes,
  resolveLinks,
  textHash,
} from '@mossgoblin/schema';
import {
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import {
  ToolError,
  agentDevice,
  linkName,
  parentTitle,
  touchedFields,
  withSeeAlso,
} from '../mcp/tools';
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

/** The deviceId a reroute's note writes carry (#235): its own, as a put back's. */
export function rerouteDevice(recordId: string): string {
  return `${agentDevice(GARDEN_AGENT)}~${recordId}`;
}

function runFacts(id: string, d: Record<string, unknown>): RunFacts {
  const tool = String(d['tool'] ?? '');
  return {
    id,
    at: millis(d['at']) ?? 0,
    tool,
    summary: String(d['summary'] ?? ''),
    device:
      tool === PUT_BACK_TOOL
        ? putBackDevice(id)
        : tool === REROUTE_TOOL
          ? rerouteDevice(id)
          : agentDevice(agentOf(d)),
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

/** Names to ids across the gardener's notes, titles and other names only. */
async function namesOf(db: Firestore, uid: string): Promise<Map<string, string>> {
  const named = await db
    .collection(paths.notes(uid))
    .select('title', 'kind', 'synonyms', 'archived', 'deletedAt')
    .get();
  return nameIndex(
    named.docs.map((d) => ({
      id: d.id,
      title: String(d.get('title') ?? ''),
      kind: typeof d.get('kind') === 'string' ? d.get('kind') : 'text',
      synonyms: Array.isArray(d.get('synonyms')) ? d.get('synonyms').map(String) : undefined,
      // A note in Trash answers to no name (#217).
      archived: d.get('archived') === true || d.get('deletedAt') !== undefined,
    })),
  );
}

/** A note as it stands, or undefined when it is not there or in Trash (#217): gone. */
function noteFacts(snap: DocumentSnapshot): NoteFacts | undefined {
  if (!snap.exists) return undefined;
  const d = snap.data() ?? {};
  if (d['deletedAt'] !== undefined) return undefined;
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
  const index = await namesOf(db, uid);
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
      // Filing keeps the hash of the text it rewrote in its record (#206);
      // without one it wrote no text, whatever the note's baseHash says.
      const recorded = t.before?.['body'];
      const hash = t.before
        ? typeof recorded === 'string'
          ? recorded
          : undefined
        : notes.get(t.id)?.baseHash;
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

/**
 * Files under project `projectId` the notes put back `putBackRunId`
 * took out of a filing (#235, step 2 of #154): the way the assistant's
 * filing would have, a project with `parent`, any other note with the
 * "See also [[Project]]" line `link_notes` adds under the text, which
 * stays as it is. Only Eric's own put back of an assistant's filing, a
 * merge or a reroute (`rerouteNotes`), and only the notes that put back
 * wrote and that are still live; for a merge, the originals it
 * restored. Recorded as a run of its own, id `rerouteId(putBackRunId)`,
 * with each note's fields before, so it shows in What assistants
 * changed and can be put back. Counts toward the day's put backs.
 */
export async function reroute(
  db: Firestore,
  uid: string,
  putBackRunId: string,
  projectId: string,
  now: number = Date.now(),
): Promise<PutBackResult> {
  if (!putBackRunId || putBackRunId.includes('/'))
    throw new PutBackRefused('invalid-argument', 'Which put back?');
  if (!projectId || projectId.includes('/'))
    throw new PutBackRefused('invalid-argument', 'Which project?');
  const { base: baseId, depth } = putBackDepth(putBackRunId);
  if (depth !== 1)
    throw new PutBackRefused('failed-precondition', 'Only a put back of a filing is filed again.');
  const recordId = rerouteId(putBackRunId);
  const modules = await db.doc(paths.modules(uid)).get();
  if (!moduleOn(modules.data() as Parameters<typeof moduleOn>[0], 'projects'))
    throw new PutBackRefused('failed-precondition', 'Projects is switched off in Settings.');
  const index = await namesOf(db, uid);
  const activity = db.collection(paths.activity(uid));
  const notesCol = db.collection(paths.notes(uid));
  const usageRef = db.doc(paths.usage(uid, new Date(now).toISOString().slice(0, 10)));
  return db.runTransaction(async (tx) => {
    const [putBackDoc, baseDoc, doneDoc, projectDoc, usage] = await tx.getAll(
      activity.doc(putBackRunId),
      activity.doc(baseId),
      activity.doc(recordId),
      notesCol.doc(projectId),
      usageRef,
    );
    if (doneDoc.exists) return { status: 'already', id: recordId, notes: 0 };
    if (!putBackDoc.exists || putBackDoc.get('tool') !== PUT_BACK_TOOL)
      throw new PutBackRefused('not-found', 'No such put back.');
    if (!baseDoc.exists) throw new PutBackRefused('not-found', 'The change it put back is gone.');
    const base = runFacts(baseId, baseDoc.data()!);
    const putBackRun = runFacts(putBackRunId, putBackDoc.data()!);
    const project = projectDoc.data();
    if (
      !projectDoc.exists ||
      project?.['conceptType'] !== 'project' ||
      project['archived'] === true ||
      project['deletedAt'] !== undefined
    )
      throw new PutBackRefused('not-found', 'That project is gone.');
    const projectTitle = String(project['title'] ?? '');

    const baseSnaps = base.notes.length
      ? await tx.getAll(...base.notes.map((t) => notesCol.doc(t.id)))
      : [];
    const isProject = (id: string) =>
      baseSnaps.find((s) => s.id === id)?.get('conceptType') === 'project';
    const wrote = new Set(putBackRun.notes.map((t) => t.id));
    const ids = rerouteNotes(base, isProject).filter((id) => wrote.has(id) && id !== projectId);
    if (!ids.length)
      throw new PutBackRefused('failed-precondition', 'That put back filed nothing to file again.');

    const stamp = {
      updatedAt: Timestamp.fromMillis(now),
      updatedBy: 'claude' as const,
      agent: GARDEN_AGENT,
      deviceId: rerouteDevice(recordId),
    };
    const writes: {
      id: string;
      update: Record<string, unknown>;
      current: Record<string, unknown>;
    }[] = [];
    for (const id of ids) {
      const snap = baseSnaps.find((s) => s.id === id)!;
      const current = snap.data();
      if (
        !snap.exists ||
        !current ||
        current['archived'] === true ||
        current['deletedAt'] !== undefined
      )
        continue;
      const update: Record<string, unknown> = {};
      if (current['conceptType'] === 'project') {
        if (current['parent'] === projectId) continue;
        try {
          await parentTitle(tx, notesCol, id, projectId);
        } catch (err) {
          if (err instanceof ToolError)
            throw new PutBackRefused('failed-precondition', err.message);
          throw err;
        }
        update['parent'] = projectId;
      } else {
        const body = String(current['body'] ?? '');
        const links = resolveLinks(wikiLinkTargets(parseNote(body)), index);
        if (links.includes(projectId)) continue;
        const name = linkName(projectId, project, index);
        if (!name)
          throw new PutBackRefused(
            'failed-precondition',
            `Nothing links to ${projectTitle || 'that project'} by name; give it its own title first.`,
          );
        const next = withSeeAlso(body, [name]);
        update['body'] = next;
        update['baseHash'] = textHash(body);
        update['links'] = resolveLinks(wikiLinkTargets(parseNote(next)), index);
      }
      writes.push({ id, update, current });
    }
    if (!writes.length)
      throw new PutBackRefused(
        'failed-precondition',
        `Already filed under ${projectTitle || 'that project'}.`,
      );
    const used = Number(usage.get('putBacks') ?? 0);
    if (used >= DAILY_PUT_BACKS) {
      throw new PutBackRefused(
        'resource-exhausted',
        `Today’s ${DAILY_PUT_BACKS} put backs are used up; try again tomorrow.`,
      );
    }
    const touched = writes.map((w) => touchedFields(w.id, w.current, w.update));
    for (const w of writes) {
      const update = { ...w.update, ...stamp };
      Note.parse({ ...w.current, ...update });
      tx.update(notesCol.doc(w.id), update);
    }
    const what =
      writes.length === 1
        ? String(writes[0].current['title'] ?? '') || 'a note'
        : `${writes.length} notes`;
    tx.set(
      activity.doc(recordId),
      Activity.parse({
        at: Timestamp.fromMillis(now),
        tool: REROUTE_TOOL,
        summary: `Filed ${what} under ${projectTitle || 'a project'}`,
        notes: touched,
        reminders: [],
        agent: GARDEN_AGENT,
      }),
    );
    tx.set(usageRef, { putBacks: used + 1 }, { merge: true });
    return { status: 'done', id: recordId, notes: writes.length };
  });
}
