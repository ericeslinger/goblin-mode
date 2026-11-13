// Put back (#154 step 1) over Firestore: reads the run, its notes and
// the texts its writes replaced, and writes the put back with its own
// record in one transaction (DESIGN.md, Trust, step 1). A sealed note's
// text, and the copies of it in History and its replaced texts, are
// opened with one codec for the call and written back in the note's
// own form (note encryption step 3c, 2026-11-13); a note that cannot be
// opened here refuses the whole put back, leaving every note as stored.
import { parseNote, wikiLinkTargets } from '@mossgoblin/editor/grammar';
import {
  Activity,
  CONTEXT_ID,
  type CorrectionNote,
  type FieldBefore,
  GARDEN_AGENT,
  Note,
  PUT_BACK_TOOL,
  REROUTE_TOOL,
  agentOf,
  canPutBack,
  correctionLine,
  moduleOn,
  nameIndex,
  paths,
  putBackDepth,
  putBackId,
  rerouteId,
  rerouteNotes,
  resolveLinks,
  textHash,
  withCorrection,
  zonedDay,
} from '@mossgoblin/schema';
import {
  type DocumentReference,
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import {
  type KeyFor,
  NoteCodec,
  NoteSnap,
  SealedNoteError,
  logLeftSealed,
  sealFields,
  shownTitle,
  storedText,
} from '../mcp/note-text';
import {
  ToolError,
  agentDevice,
  keepLockedLinks,
  linkName,
  parentTitle,
  touchedFields,
  withSeeAlso,
} from '../mcp/tools';
import { dataKeyFor } from '../note-keys/client';
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

type Data = Record<string, unknown>;

/** What the app is told when a note the call needs is sealed and cannot be opened here. */
export const SEALED_REFUSAL =
  'A note it changed is sealed and cannot be opened here yet, so nothing was changed; ' +
  'try again later.';

/**
 * Runs `work`; a sealed note it met that cannot be opened here refuses
 * the call (the transaction wrote nothing), said once in the log with
 * the note id and why.
 */
async function refusingSealed<T>(where: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (!(err instanceof SealedNoteError)) throw err;
    logLeftSealed(logger, where, err);
    throw new PutBackRefused('failed-precondition', SEALED_REFUSAL);
  }
}

/** A title as a record or summary holds it: sealed when the note's title or body is. */
function recordTitle(title: string, snap: NoteSnap, sealed?: string): string {
  const form = snap.forms.body === 'sealed' ? 'sealed' : snap.forms.title;
  return shownTitle(title, form, sealed);
}

/** The deviceId a put back's note writes carry: its own, so History keeps what it replaced. */
export function putBackDevice(recordId: string): string {
  return `${agentDevice(GARDEN_AGENT)}~${recordId}`;
}

/** The deviceId a reroute's note writes carry (#235): its own, as a put back's. */
export function rerouteDevice(recordId: string): string {
  return `${agentDevice(GARDEN_AGENT)}~${recordId}`;
}

/** The day `now` falls on in `timeZone`, YYYY-MM-DD; UTC without one, or for a zone not known. */
export function dayIn(now: number, timeZone?: string): string {
  try {
    return zonedDay(now, timeZone || 'UTC');
  } catch {
    return zonedDay(now, 'UTC');
  }
}

/** Whether a note's title is a page's words (#239): a clipping, a recipe imported from a page. */
function webOf(d: Record<string, unknown> | undefined): CorrectionNote['web'] {
  if (!d) return undefined;
  if (d['kind'] === 'clipping') return 'clipping';
  const url = (d['source'] as { url?: unknown } | undefined)?.url;
  if (d['kind'] === 'recipe' && typeof url === 'string' && url) return 'recipe';
  return undefined;
}

/**
 * A note as a correction names it: its title now (`d`, opened), if it
 * is there, else the record's. The context note keeps its own form, so
 * a sealed note's opened title may go into a plain one, as a link Eric
 * types does (2026-11-12).
 */
function correctionNote(
  t: { id: string; title: string },
  d: Record<string, unknown> | undefined,
): CorrectionNote {
  const web = webOf(d);
  return {
    title: d && typeof d['title'] === 'string' ? d['title'] : t.title,
    was: t.title,
    ...(web ? { web } : {}),
  };
}

type Stamp = {
  updatedAt: Timestamp;
  updatedBy: 'claude';
  agent: string;
  deviceId: string;
};

/**
 * Writes `line` under Corrections in the context note (#239, step 3 of
 * #154), in the put back's or reroute's own transaction, with its
 * stamp: Eric's text stays byte for byte (`withCorrection`), the title
 * as it is, and no record lists it, so it is no run of its own. Made
 * as the app makes it when there is none; left alone when Eric
 * archived it or put it in Trash.
 */
async function writeCorrection(
  tx: Transaction,
  ref: DocumentReference,
  snap: NoteSnap,
  line: string,
  stamp: Stamp,
  index: Map<string, string>,
  locked: ReadonlySet<string>,
  codec: NoteCodec,
): Promise<void> {
  if (!snap.exists) {
    const body = withCorrection('', line);
    tx.create(
      ref,
      Note.parse({
        kind: 'context',
        body,
        title: 'Context for Claude',
        // Its name is fixed: a settle never retitles it.
        titleSource: 'user',
        links: resolveLinks(wikiLinkTargets(parseNote(body)), index),
        tags: [],
        archived: false,
        createdAt: stamp.updatedAt,
        ...stamp,
      }),
    );
    return;
  }
  // A sealed context note that did not open takes no line: it is left
  // as stored, and the put back goes ahead without it.
  if (snap.locked) {
    logger.warn('put back left a sealed context note as stored: it cannot be opened here', {
      noteId: snap.id,
    });
    return;
  }
  const current = snap.data()!;
  if (current['archived'] === true || current['deletedAt'] !== undefined) return;
  const before = String(current['body'] ?? '');
  const body = withCorrection(before, line);
  const update = {
    ...stamp,
    body,
    baseHash: textHash(before),
    links: keepLockedLinks(
      resolveLinks(wikiLinkTargets(parseNote(body)), index),
      current['links'],
      locked,
    ),
  };
  Note.parse({ ...current, ...update });
  tx.update(ref, await sealFields(codec, ref.id, update, snap.forms));
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

/**
 * Names to ids across the gardener's notes, titles and other names only,
 * a sealed title opened; and the notes whose sealed title did not open
 * here, which answer to no name, so a link to one is kept as stored.
 */
async function namesOf(
  db: Firestore,
  uid: string,
  codec: NoteCodec,
): Promise<{ index: Map<string, string>; locked: Set<string> }> {
  const named = await db
    .collection(paths.notes(uid))
    .select('title', 'kind', 'synonyms', 'archived', 'deletedAt')
    .get();
  const snaps = await Promise.all(named.docs.map((d) => NoteSnap.open(codec, d)));
  const locked = new Set(snaps.filter((n) => n.locked).map((n) => n.id));
  const index = nameIndex(
    snaps.map((n) => {
      const d = n.known() ?? {};
      return {
        id: n.id,
        title: String(d['title'] ?? ''),
        kind: typeof d['kind'] === 'string' ? d['kind'] : 'text',
        synonyms: Array.isArray(d['synonyms']) ? d['synonyms'].map(String) : undefined,
        // A note in Trash answers to no name (#217).
        archived: d['archived'] === true || d['deletedAt'] !== undefined,
      };
    }),
  );
  return { index, locked };
}

/**
 * A note as it stands, its text opened, or undefined when it is not there
 * or in Trash (#217): gone. Throws SealedNoteError when it is sealed and
 * did not open: nothing is put back over text not seen here.
 */
function noteFacts(snap: NoteSnap): NoteFacts | undefined {
  if (!snap.exists) return undefined;
  if (snap.known()?.['deletedAt'] !== undefined) return undefined;
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
    // As stored: a field put back goes back to the same note.
    fields: snap.stored(),
  };
}

/**
 * A copy of note `noteId`'s body (a replaced text or a History version),
 * opened under the note's own id; undefined when it is sealed and does
 * not open with this key. No key at all throws, refusing the put back.
 */
async function openCopy(
  codec: NoteCodec,
  noteId: string,
  d: Data | undefined,
): Promise<string | undefined> {
  if (typeof d?.['body'] !== 'string') return undefined;
  try {
    return await codec.open(noteId, 'body', storedText(d, 'body'));
  } catch (err) {
    if (err instanceof SealedNoteError && err.reason === 'did-not-open') return undefined;
    throw err;
  }
}

/**
 * Puts back activity run `runId` of gardener `uid`: the notes it wrote
 * go back to the text they had before it, notes it archived come back,
 * a merge's originals come back and the merged note is archived, a
 * note it made is archived (never deleted), and the fields a filing or
 * a finished queue item changed get the values its record kept (#206).
 * Recorded as a run of its own, id `putBackId(runId)`, so it shows in
 * What assistants changed and can be put back in turn. A put back of
 * an assistant's run also leaves a line under Corrections in Eric's
 * Context for Claude (#239), dated in `timeZone` (UTC without one); a
 * put back of a put back, or of Eric's own reroute, leaves none.
 */
export async function putBack(
  db: Firestore,
  uid: string,
  runId: string,
  now: number = Date.now(),
  timeZone?: string,
  keyFor: KeyFor = dataKeyFor,
): Promise<PutBackResult> {
  if (!runId || runId.includes('/')) throw new PutBackRefused('invalid-argument', 'Which run?');
  return refusingSealed('revertRun', () => putBackRun(db, uid, runId, now, timeZone, keyFor));
}

async function putBackRun(
  db: Firestore,
  uid: string,
  runId: string,
  now: number,
  timeZone: string | undefined,
  keyFor: KeyFor,
): Promise<PutBackResult> {
  const recordId = putBackId(runId);
  const codec = new NoteCodec(uid, keyFor);
  // Names only, for the links of a text put back; read before the transaction.
  const { index, locked } = await namesOf(db, uid, codec);
  const activity = db.collection(paths.activity(uid));
  const usageRef = db.doc(paths.usage(uid, new Date(now).toISOString().slice(0, 10)));
  const contextRef = db.doc(paths.note(uid, CONTEXT_ID));
  return db.runTransaction(async (tx) => {
    const [runDoc, doneDoc, usage, contextRaw] = await tx.getAll(
      activity.doc(runId),
      activity.doc(recordId),
      usageRef,
      contextRef,
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
    const raw = ids.length ? await tx.getAll(...ids.map((id) => db.doc(paths.note(uid, id)))) : [];
    const snaps = await Promise.all(raw.map((s) => NoteSnap.open(codec, s)));
    const notes = new Map<string, NoteFacts>();
    for (const s of snaps) {
      const n = noteFacts(s);
      if (n) notes.set(n.id, n);
    }
    /** A live note's text opened, for the correction line. */
    const openedOf = (id: string) => {
      const s = snaps.find((n) => n.id === id);
      return notes.has(id) ? s?.data() : undefined;
    };
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
      // Copies of the note's own body, in its stored form: each opens
      // with the note's aad, and the hash is of the opened text.
      const replaced = await tx.get(db.doc(`${paths.replaced(uid, t.id)}/${hash}`));
      const body = await openCopy(codec, t.id, replaced.data());
      if (body !== undefined && textHash(body) === hash) {
        textBefore.set(t.id, body);
        continue;
      }
      const kept = await tx.get(
        db.collection(paths.history(uid, t.id)).orderBy('savedAt', 'desc').limit(VERSIONS_SEARCHED),
      );
      for (const d of kept.docs) {
        const b = await openCopy(codec, t.id, d.data());
        if (b !== undefined && textHash(b) === hash) {
          textBefore.set(t.id, b);
          break;
        }
      }
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

    // The correction, for the next run (#239): only of an assistant's
    // own run, and not when the run being put back wrote the context
    // note itself, which the put back is already writing.
    let line: string | undefined;
    if (depth === 0 && run.tool !== REROUTE_TOOL && !plan.writes.some((w) => w.id === CONTEXT_ID)) {
      const filedUnder = run.tool === 'refile' ? plan.writes[0]?.before?.['parent'] : undefined;
      const projectDoc =
        typeof filedUnder === 'string' && filedUnder && !filedUnder.includes('/')
          ? await NoteSnap.open(codec, await tx.get(db.doc(paths.note(uid, filedUnder))))
          : undefined;
      // A sealed project that did not open goes unnamed in the line.
      const project =
        projectDoc?.exists && !projectDoc.locked
          ? String(projectDoc.data()?.['title'] ?? '')
          : undefined;
      line = correctionLine({
        kind: 'put-back',
        tool: run.tool,
        summary: run.summary,
        notes: run.notes.map((t) => correctionNote(t, openedOf(t.id))),
        ...(project ? { project } : {}),
        day: dayIn(now, timeZone),
      });
    }

    const stamp = {
      updatedAt: Timestamp.fromMillis(now),
      updatedBy: 'claude' as const,
      agent: GARDEN_AGENT,
      deviceId: putBackDevice(recordId),
    };
    const recorded: { id: string; title: string; before?: Record<string, FieldBefore> }[] = [];
    for (const w of plan.writes) {
      const snap = snaps.find((s) => s.id === w.id)!;
      const current = snap.stored()!;
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
        // A link to a sealed note that did not open here is kept.
        update['links'] = keepLockedLinks(
          resolveLinks(wikiLinkTargets(parseNote(w.body)), index),
          current['links'],
          locked,
        );
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
      // The text put back takes the note's form: sealed again under its
      // id. A field before that was stored sealed goes back as it was,
      // once it opens as that field of this note (2026-11-13).
      const restored = new Set(Object.keys(w.fields ?? {}));
      tx.update(
        db.doc(paths.note(uid, w.id)),
        await sealFields(codec, w.id, update, snap.forms, restored),
      );
      recorded.push({
        id: w.id,
        title: recordTitle(w.title, snap),
        ...(w.before ? { before: w.before } : {}),
      });
    }
    tx.set(
      activity.doc(recordId),
      Activity.parse({
        at: Timestamp.fromMillis(now),
        tool: PUT_BACK_TOOL,
        summary: putBackSummary(run, plan),
        notes: recorded,
        reminders: [],
        agent: GARDEN_AGENT,
      }),
    );
    tx.set(usageRef, { putBacks: used + 1 }, { merge: true });
    if (line) {
      const contextDoc = await NoteSnap.open(codec, contextRaw);
      await writeCorrection(tx, contextRef, contextDoc, line, stamp, index, locked, codec);
    }
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
 * Leaves a line under Corrections in Eric's Context for Claude (#239),
 * dated in `timeZone` (UTC without one), unless what the put back
 * undid was a reroute of his own.
 */
export async function reroute(
  db: Firestore,
  uid: string,
  putBackRunId: string,
  projectId: string,
  now: number = Date.now(),
  timeZone?: string,
  keyFor: KeyFor = dataKeyFor,
): Promise<PutBackResult> {
  return refusingSealed('rerouteRun', () =>
    rerouteRun(db, uid, putBackRunId, projectId, now, timeZone, keyFor),
  );
}

async function rerouteRun(
  db: Firestore,
  uid: string,
  putBackRunId: string,
  projectId: string,
  now: number,
  timeZone: string | undefined,
  keyFor: KeyFor,
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
  const codec = new NoteCodec(uid, keyFor);
  const { index, locked } = await namesOf(db, uid, codec);
  const activity = db.collection(paths.activity(uid));
  const notesCol = db.collection(paths.notes(uid));
  const usageRef = db.doc(paths.usage(uid, new Date(now).toISOString().slice(0, 10)));
  const contextRef = notesCol.doc(CONTEXT_ID);
  return db.runTransaction(async (tx) => {
    const [putBackDoc, baseDoc, doneDoc, projectRaw, usage, contextRaw] = await tx.getAll(
      activity.doc(putBackRunId),
      activity.doc(baseId),
      activity.doc(recordId),
      notesCol.doc(projectId),
      usageRef,
      contextRef,
    );
    if (doneDoc.exists) return { status: 'already', id: recordId, notes: 0 };
    if (!putBackDoc.exists || putBackDoc.get('tool') !== PUT_BACK_TOOL)
      throw new PutBackRefused('not-found', 'No such put back.');
    if (!baseDoc.exists) throw new PutBackRefused('not-found', 'The change it put back is gone.');
    const base = runFacts(baseId, baseDoc.data()!);
    const putBackRun = runFacts(putBackRunId, putBackDoc.data()!);
    const projectDoc = await NoteSnap.open(codec, projectRaw);
    const known = projectDoc.known();
    if (
      !projectDoc.exists ||
      known?.['conceptType'] !== 'project' ||
      known['archived'] === true ||
      known['deletedAt'] !== undefined
    )
      throw new PutBackRefused('not-found', 'That project is gone.');
    // Its name is needed to link to it: a sealed one that did not open refuses.
    const project = projectDoc.data()!;
    const projectTitle = String(project['title'] ?? '');

    const baseRaw = base.notes.length
      ? await tx.getAll(...base.notes.map((t) => notesCol.doc(t.id)))
      : [];
    const baseSnaps = await Promise.all(baseRaw.map((s) => NoteSnap.open(codec, s)));
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
      /** Opened. */
      current: Record<string, unknown>;
      snap: NoteSnap;
    }[] = [];
    for (const id of ids) {
      const snap = baseSnaps.find((s) => s.id === id)!;
      const known = snap.known();
      if (!snap.exists || !known || known['archived'] === true || known['deletedAt'] !== undefined)
        continue;
      // Throws SealedNoteError when it did not open: nothing is filed.
      const current = snap.data()!;
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
        const links = keepLockedLinks(
          resolveLinks(wikiLinkTargets(parseNote(body)), index),
          current['links'],
          locked,
        );
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
        update['links'] = keepLockedLinks(
          resolveLinks(wikiLinkTargets(parseNote(next)), index),
          current['links'],
          locked,
        );
      }
      writes.push({ id, update, current, snap });
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
    // The correction, for the next run (#239): where the assistant had
    // filed them, read as the reroute reads what to file; none after a
    // put back of Eric's own reroute.
    let line: string | undefined;
    if (base.tool !== REROUTE_TOOL && !writes.some((w) => w.id === CONTEXT_ID)) {
      let from: string | undefined;
      let mergedInto: CorrectionNote | undefined;
      /** A note's text opened; a sealed one that did not open, none. */
      const dataOf = (id: string) => {
        const s = baseSnaps.find((n) => n.id === id);
        return s?.locked ? undefined : s?.data();
      };
      if (base.tool === 'refile') {
        const was = putBackRun.notes.find((t) => t.id === writes[0].id)?.before?.['parent'];
        if (typeof was === 'string' && was && !was.includes('/')) {
          const doc = await NoteSnap.open(codec, await tx.get(notesCol.doc(was)));
          // A sealed project that did not open goes unnamed in the line.
          if (doc.exists && !doc.locked) from = String(doc.data()?.['title'] ?? '') || undefined;
        }
      } else if (base.tool === 'link_notes') {
        const target = base.notes.slice(1).find((t) => isProject(t.id));
        if (target) from = correctionNote(target, dataOf(target.id)).title || undefined;
      } else if (base.tool === 'merge_notes' && base.notes[0]) {
        mergedInto = correctionNote(base.notes[0], dataOf(base.notes[0].id));
      }
      line = correctionLine({
        kind: 'reroute',
        notes: writes.map((w) =>
          correctionNote(
            { id: w.id, title: base.notes.find((t) => t.id === w.id)?.title ?? '' },
            w.current,
          ),
        ),
        to: projectTitle,
        // Filed back where the assistant had it: no "not" to say.
        ...(from && from !== projectTitle ? { from } : {}),
        ...(mergedInto ? { mergedInto } : {}),
        day: dayIn(now, timeZone),
      });
    }
    // Each note's fields before, as stored (a value goes back to the same
    // note), its body by the hash of its text; its title as a record
    // names it.
    const touched = writes.map((w) => ({
      ...touchedFields(w.id, { ...w.snap.stored(), body: w.current['body'] }, w.update),
      title: recordTitle(String(w.current['title'] ?? ''), w.snap),
    }));
    for (const w of writes) {
      const update = { ...w.update, ...stamp };
      Note.parse({ ...w.current, ...update });
      // Text written keeps the note's form: sealed again under its id.
      tx.update(notesCol.doc(w.id), await sealFields(codec, w.id, update, w.snap.forms));
    }
    const what =
      writes.length === 1
        ? recordTitle(String(writes[0].current['title'] ?? ''), writes[0].snap, 'a sealed note') ||
          'a note'
        : `${writes.length} notes`;
    tx.set(
      activity.doc(recordId),
      Activity.parse({
        at: Timestamp.fromMillis(now),
        tool: REROUTE_TOOL,
        summary: `Filed ${what} under ${recordTitle(projectTitle, projectDoc, 'a sealed project') || 'a project'}`,
        notes: touched,
        reminders: [],
        agent: GARDEN_AGENT,
      }),
    );
    tx.set(usageRef, { putBacks: used + 1 }, { merge: true });
    if (line) {
      const contextDoc = await NoteSnap.open(codec, contextRaw);
      await writeCorrection(tx, contextRef, contextDoc, line, stamp, index, locked, codec);
    }
    return { status: 'done', id: recordId, notes: writes.length };
  });
}
