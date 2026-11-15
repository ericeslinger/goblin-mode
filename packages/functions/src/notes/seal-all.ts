// Seal everything now (note encryption, the migration, Eric,
// 2026-11-15; DESIGN.md, "Note encryption", The migration). With the
// gardener's switch on, every write seals what it touches; this seals
// the rest, once, when Eric asks: every note's plain sealed fields
// (archived and in Trash too) and its `baseHash`, its History versions,
// the suggestions' and runs' text, and the names and fields before in
// What assistants changed. Replaced texts are left to expire (Eric,
// 2026-11-15).
//
// Every write is a transaction that reads the document as it is now,
// changes the form of its text and nothing else (no `updatedAt`,
// `updatedBy` or `deviceId`, so no trigger takes it for an edit: the
// trigger analysis in DESIGN.md), and checks before writing that each
// sealed value opens back to exactly the text it replaces. A value
// sealed already is left as it is, so a pass is idempotent and running
// it again is how it resumes; nothing records progress. A document
// whose sealed text does not open, or that something is working on, is
// left as stored and counted.
//
// Every note value is sealed through `sealFields` and every record
// value through `sealRecord`, hashes through the codec: the sanctioned
// helpers, nothing beside them.
import {
  PUT_BACK_TOOL,
  SEALED_FIELDS,
  SEAL_KINDS,
  type SealCounted,
  type SealCursor,
  type SealKind,
  type SealPass,
  type SealReport,
  type SealedField,
  emptySealReport,
  fieldValue,
  isKeyedHash,
  isSealed,
  paths,
  summarySaysText,
} from '@mossgoblin/schema';
import {
  FieldPath,
  type Firestore,
  type Query,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore';
import {
  type NoteCodec,
  NoteSnap,
  SEALED_TITLE,
  SealedNoteError,
  SealedRecordError,
  sealFields,
  storedText,
} from '../mcp/note-text';
import { NotVerified, type SealedUnit, sealRun } from '../agent/seal-runs';

type Data = Record<string, unknown>;

/** Notes a page: each with its History, one transaction a document. */
export const NOTE_PAGE = 25;
/** History versions, suggestions, runs or activity entries a page. */
export const RECORD_PAGE = 100;
/** Transactions at once within a page, well inside Firestore's limits. */
export const AT_ONCE = 8;
/** How many of a note's newest History versions a hash's text is looked for in, as put back does. */
export const VERSIONS_SEARCHED = 50;

/**
 * What a hash is made of when the text it named is kept nowhere any
 * more (not the note's body, not a replaced text, not in History): a
 * string no note can hold (it starts with NUL). Its keyed hash matches
 * no text, as the plain hash it replaces matched none that is kept, so
 * the merge, put back and Show changes behave exactly as before, and
 * nothing guessable is left.
 */
export const UNKEPT_TEXT = '\u0000mossgoblin/text-no-longer-kept';

/** A recipe being read: its trigger runs on every write while it is requested. */
const IMPORT_BUSY: readonly unknown[] = ['requested', 'working'];

export interface SealAllDeps {
  db: Firestore;
  /** The gardener's codec, built with the switch (`sealingIn`). */
  codec: NoteCodec;
  uid: string;
  dryRun: boolean;
  /** No new page is started after this (ms). */
  deadline: number;
  now: () => number;
  /** Whether the switch is still on: read between pages, so turning it off stops the pass. */
  stillOn: () => Promise<boolean>;
}

/** The switch went off while a pass was running: it stopped where it was. */
export class SealingTurnedOff extends Error {
  override readonly name = 'SealingTurnedOff';
}

/**
 * One pass, from `cursor` (the start when absent) until everything is
 * done or the deadline is reached; then the cursor to go on from.
 */
export async function sealAllPass(deps: SealAllDeps, cursor?: SealCursor): Promise<SealPass> {
  const report = emptySealReport(deps.dryRun);
  const start = cursor ? SEAL_KINDS.indexOf(cursor.kind) : 0;
  for (let k = Math.max(0, start); k < SEAL_KINDS.length; k++) {
    const kind = SEAL_KINDS[k];
    let after = k === start ? cursor?.after : undefined;
    for (;;) {
      if (deps.now() > deps.deadline) return { done: false, cursor: { kind, after }, report };
      if (!(await deps.stillOn())) throw new SealingTurnedOff();
      const page = await pageOf(deps, kind, after);
      if (!page.length) break;
      if (kind === 'notes') {
        for (const id of page) {
          if (deps.now() > deps.deadline) {
            return { done: false, cursor: { kind, after }, report };
          }
          await sealNoteWhole(deps, id, report);
          after = id;
        }
      } else {
        await atOnce(page, async (id) =>
          count(report, counted(kind), await sealOne(deps, kind, id)),
        );
        after = page.at(-1);
      }
      if (page.length < (kind === 'notes' ? NOTE_PAGE : RECORD_PAGE)) break;
    }
  }
  return { done: true, report };
}

const COLLECTION: Record<SealKind, (uid: string) => string> = {
  notes: paths.notes,
  suggestions: paths.proposals,
  runs: paths.runs,
  activity: paths.activity,
};

const counted = (kind: SealKind): SealCounted => kind;

/** The next page of document ids in `kind`, in id order, ids only. */
async function pageOf(deps: SealAllDeps, kind: SealKind, after?: string): Promise<string[]> {
  return idsOf(
    deps.db.collection(COLLECTION[kind](deps.uid)),
    after,
    kind === 'notes' ? NOTE_PAGE : RECORD_PAGE,
  );
}

async function idsOf(collection: Query, after: string | undefined, limit: number) {
  let q = collection.orderBy(FieldPath.documentId());
  if (after !== undefined) q = q.startAfter(after);
  const snap = await q.select().limit(limit).get();
  return snap.docs.map((d) => d.id);
}

/** Runs `fn` over `items`, AT_ONCE at a time. */
async function atOnce<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

interface Unit extends SealedUnit {
  /** Hashes whose text is kept nowhere, made a hash of nothing. */
  unkept?: number;
}

function count(report: SealReport, what: SealCounted, unit: Unit): void {
  if (unit.result === 'sealed') report.sealed[what]++;
  else if (unit.result !== 'already') {
    report.left[what][unit.result] = (report.left[what][unit.result] ?? 0) + 1;
  }
  if (unit.idKept) report.left[what]['id-kept'] = (report.left[what]['id-kept'] ?? 0) + 1;
  if (unit.moved) report.runsMoved++;
  report.hashesUnkept += unit.unkept ?? 0;
}

function sealOne(deps: SealAllDeps, kind: Exclude<SealKind, 'notes'>, id: string) {
  const { db, codec, uid, dryRun } = deps;
  switch (kind) {
    case 'suggestions':
      return guarded(() => sealSuggestion(db, codec, uid, id, dryRun));
    case 'runs':
      return sealRun(db, codec, uid, id, dryRun);
    case 'activity':
      return guarded(() => relabelEntry(db, codec, uid, id, dryRun));
  }
}

/** A document whose text does not open, or does not open back, is left as stored. */
async function guarded(work: () => Promise<Unit>): Promise<Unit> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof SealedNoteError || err instanceof SealedRecordError) {
      return { result: 'cannot-open' };
    }
    if (err instanceof NotVerified) return { result: 'not-verified' };
    throw err;
  }
}

/** A note, then its History versions, then its replaced texts counted. */
async function sealNoteWhole(deps: SealAllDeps, id: string, report: SealReport): Promise<void> {
  const { db, codec, uid, dryRun } = deps;
  count(report, 'notes', await guarded(() => sealNote(db, codec, uid, id, dryRun)));
  const versions = db.collection(paths.history(uid, id));
  let after: string | undefined;
  for (;;) {
    const page = await idsOf(versions, after, RECORD_PAGE);
    await atOnce(page, async (v) =>
      count(report, 'versions', await guarded(() => sealVersion(db, codec, uid, id, v, dryRun))),
    );
    if (page.length < RECORD_PAGE) break;
    after = page.at(-1);
  }
  await countReplaced(db, uid, id, report);
}

/** Whether a stored value of a sealed field holds any plain text. */
function holdsPlain(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && !isSealed(v));
  return typeof value === 'string' && !isSealed(value);
}

const plainHash = (hash: unknown): hash is string =>
  typeof hash === 'string' && hash !== '' && !isKeyedHash(hash);

/**
 * The text of note `noteId` whose plain hash is `hash`: its body now,
 * the replaced text kept under that hash, or one of its newest History
 * versions, each opened; undefined when none of them is it. Checked as
 * the kind of hash it is (`hashMatcher`), as the merge and put back
 * check it.
 */
async function textOfHash(
  tx: Transaction,
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  noteId: string,
  hash: string,
  body: string | undefined,
): Promise<string | undefined> {
  const matches = await codec.hashMatcher(noteId, 'sealed', [hash]);
  if (body !== undefined && matches(hash, body)) return body;
  const opened = async (d: Data | undefined) => {
    if (!d) return undefined;
    try {
      return await codec.open(noteId, 'body', storedText(d, 'body'));
    } catch (err) {
      if (err instanceof SealedNoteError) return undefined;
      throw err;
    }
  };
  const replaced = await opened(
    (await tx.get(db.doc(`${paths.replaced(uid, noteId)}/${hash}`))).data(),
  );
  if (replaced !== undefined && matches(hash, replaced)) return replaced;
  const kept = await tx.get(
    db.collection(paths.history(uid, noteId)).orderBy('savedAt', 'desc').limit(VERSIONS_SEARCHED),
  );
  for (const d of kept.docs) {
    const text = await opened(d.data());
    if (text !== undefined && matches(hash, text)) return text;
  }
  return undefined;
}

/** The keyed hash to store in place of plain `hash` of note `noteId`, and whether its text was kept. */
async function keyedInPlace(
  tx: Transaction,
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  noteId: string,
  hash: string,
  body: string | undefined,
): Promise<{ hash: string; unkept: boolean }> {
  const text = await textOfHash(tx, db, codec, uid, noteId, hash, body);
  return {
    hash: await codec.hashText(noteId, text ?? UNKEPT_TEXT, 'sealed'),
    unkept: text === undefined,
  };
}

/** Checks that `written[field]` opens back to `text` as field `field` of note `noteId`. */
async function opensBack(
  codec: NoteCodec,
  noteId: string,
  field: SealedField,
  written: unknown,
  text: unknown,
): Promise<void> {
  const one = async (w: unknown, t: unknown) => {
    if (typeof w !== 'string' || typeof t !== 'string' || !isSealed(w)) throw new NotVerified();
    if ((await codec.open(noteId, field, w)) !== t) throw new NotVerified();
  };
  if (Array.isArray(text)) {
    if (!Array.isArray(written) || written.length !== text.length) throw new NotVerified();
    for (let i = 0; i < text.length; i++) await one(written[i], text[i]);
  } else await one(written, text);
}

/** Sealed elements of the other names are checked and kept as they are; plain ones sealed. */
const KEEP_SEALED: ReadonlySet<string> = new Set(['synonyms']);

/**
 * Note `id`: every sealed field still plain, sealed under its id, and a
 * plain `baseHash` keyed (of the same text, or of nothing when that
 * text is kept nowhere). Nothing else of the note is written.
 */
export async function sealNote(
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  id: string,
  dryRun: boolean,
): Promise<Unit> {
  const ref = db.doc(paths.note(uid, id));
  return db.runTransaction(async (tx) => {
    const raw = await tx.get(ref);
    if (!raw.exists) return { result: 'already' };
    const note = await NoteSnap.open(codec, raw);
    const stored = note.stored()!;
    const plain = SEALED_FIELDS.filter((f) => holdsPlain(fieldValue(stored, f)));
    const base = stored['baseHash'];
    if (!plain.length && !plainHash(base)) return { result: 'already' };
    // recipeImport runs on every write while an import is asked for.
    if (IMPORT_BUSY.includes(stored['importState'])) return { result: 'busy' };
    if (note.locked) return { result: 'cannot-open' };
    const opened = note.known()!;
    let unkept = 0;
    const update: Data = {};
    // `source.text` goes by its dotted path, so the rest of `source` is untouched.
    for (const f of plain) update[f] = fieldValue(stored, f);
    if (plainHash(base)) {
      const keyed = await keyedInPlace(tx, db, codec, uid, id, base, String(opened['body'] ?? ''));
      update['baseHash'] = keyed.hash;
      if (keyed.unkept) unkept++;
    }
    if (dryRun) return { result: 'sealed', unkept };
    const written = await sealFields(codec, id, update, note.forms, KEEP_SEALED);
    for (const f of plain) {
      await opensBack(codec, id, f, fieldValue(written, f), fieldValue(opened, f));
    }
    tx.update(ref, written);
    return { result: 'sealed', unkept };
  });
}

/**
 * History version `versionId` of note `noteId`: its body and title,
 * where still plain, sealed under the note's id, so it opens with the
 * note's aad as every version does. Nothing else of it is written.
 */
export async function sealVersion(
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  noteId: string,
  versionId: string,
  dryRun: boolean,
): Promise<Unit> {
  const ref = db.doc(`${paths.history(uid, noteId)}/${versionId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { result: 'already' };
    const v = snap.data()!;
    const update: Data = {};
    for (const f of ['body', 'title'] as const) {
      if (f in v && holdsPlain(storedText(v, f))) update[f] = storedText(v, f);
    }
    if (!Object.keys(update).length) return { result: 'already' };
    if (dryRun) return { result: 'sealed' };
    const written = await sealFields(codec, noteId, update, await codec.forms(), KEEP_SEALED);
    for (const f of ['body', 'title'] as const) {
      if (f in update) await opensBack(codec, noteId, f, written[f], update[f]);
    }
    tx.update(ref, written);
    return { result: 'sealed' };
  });
}

/** Counts note `noteId`'s replaced texts still plain, in body or id, and when the last expires. */
async function countReplaced(db: Firestore, uid: string, noteId: string, report: SealReport) {
  const snap = await db.collection(paths.replaced(uid, noteId)).get();
  for (const d of snap.docs) {
    if (isKeyedHash(d.id) && isSealed(storedText(d.data(), 'body'))) continue;
    report.replaced.plain++;
    const at = d.get('expireAt');
    if (at instanceof Timestamp) {
      const iso = at.toDate().toISOString();
      if (!report.replaced.lastExpiresAt || iso > report.replaced.lastExpiresAt) {
        report.replaced.lastExpiresAt = iso;
      }
    }
  }
}

// ---- Suggestions ----

/** Whether a record names any note in the clear: the rule every new record follows. */
const namesInClear = (notes: unknown): boolean =>
  Array.isArray(notes) && notes.some((n) => (n as { title?: unknown })?.title !== SEALED_TITLE);

/** A note list with every name labelled, as a record about a sealed note names it. */
const labelled = (notes: unknown[]) => notes.map((n) => ({ ...(n as Data), title: SEALED_TITLE }));

/**
 * A refile's dedupe key, `refile:{id}:{type}:{names}`, with its names
 * part as a new one holds it (2026-11-15): the keyed hash of the
 * normalized, sorted names (`refileNamesHash`, through `hashNames`).
 * The names part of an old key is those names already (`refileNames`),
 * so the hash is the one a new suggestion of the same change gets, and
 * a dismissed suggestion still blocks it. A key with no names, or with
 * them hashed already, or not a refile's, is left as it is.
 */
export function hashedRefileKey(
  key: string,
  hashNames: (conceptId: string, names: string) => string,
): string {
  if (!key.startsWith('refile:')) return key;
  const [, id = '', type = '', ...rest] = key.split(':');
  const names = rest.join(':');
  if (!names || !id || isKeyedHash(names)) return key;
  return `refile:${id}:${type}:${hashNames(id, names)}`;
}

/** A refile suggestion's proposed names: the suggestion's own field, not a note's. */
const PROPOSED_NAMES = 'synonyms';

/** Outcomes that name no note, kept as they are. */
const PLAIN_OUTCOMES = new Set([
  'Already linked',
  'Nothing left to change',
  'Stopped partway; check the changes below',
  'Something went wrong; try again',
]);

/** What a suggestion's outcome says once the notes it named are sealed. */
export function relabelOutcome(kind: unknown, status: unknown, outcome: string, notes: number) {
  if (PLAIN_OUTCOMES.has(outcome)) return outcome;
  if (status === 'failed') return 'Could not be done; it was about a sealed note';
  if (kind === 'link') {
    const n = Math.max(1, notes - 1);
    return `Linked ${n === 1 ? 'a sealed note' : `${n} sealed notes`}`;
  }
  if (kind === 'merge') return 'Merged into a sealed note';
  return 'Changed a sealed note';
}

/**
 * Suggestion `id`: its proposed title and reason, and a refile's
 * proposed names element by element, sealed under its own id; the
 * notes it names labelled, an outcome naming them relabelled, and a
 * refile's key made to hold a keyed hash of its names, as a new
 * suggestion's does (2026-11-15). One being carried out (accepted,
 * applying) is left for the next pass.
 */
export async function sealSuggestion(
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  id: string,
  dryRun: boolean,
): Promise<Unit> {
  const ref = db.doc(`${paths.proposals(uid)}/${id}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { result: 'already' };
    const p = snap.data()!;
    const text = (['title', 'reason'] as const).filter((f) => holdsPlain(p[f]));
    const relabel = namesInClear(p['notes']);
    const key = typeof p['key'] === 'string' ? p['key'] : '';
    const proposed = Array.isArray(p[PROPOSED_NAMES]) ? (p[PROPOSED_NAMES] as unknown[]) : [];
    const plainNames = p['kind'] === 'refile' && holdsPlain(proposed);
    // The hash is asked for only when the key still says names.
    const sayNames = p['kind'] === 'refile' && hashedRefileKey(key, () => '') !== key;
    const names = plainNames || sayNames;
    if (!text.length && !relabel && !names) return { result: 'already' };
    if (p['status'] === 'accepted' || p['status'] === 'applying') return { result: 'busy' };
    if (dryRun) return { result: 'sealed' };
    const update: Data = {};
    for (const f of text) {
      const value = await codec.sealRecord('proposals', id, f, String(p[f]), 'sealed');
      if ((await codec.openRecord('proposals', id, f, value)) !== p[f]) throw new NotVerified();
      update[f] = value;
    }
    if (relabel) {
      const notes = p['notes'] as unknown[];
      update['notes'] = labelled(notes);
      if (typeof p['outcome'] === 'string') {
        update['outcome'] = relabelOutcome(p['kind'], p['status'], p['outcome'], notes.length);
      }
    }
    if (plainNames) {
      // Sealed ones stay as they are; each plain one sealed and checked.
      update[PROPOSED_NAMES] = await Promise.all(
        proposed.map(async (n) => {
          if (typeof n !== 'string' || isSealed(n)) return n;
          const value = await codec.sealRecord('proposals', id, 'synonyms', n, 'sealed');
          if ((await codec.openRecord('proposals', id, 'synonyms', value)) !== n) {
            throw new NotVerified();
          }
          return value;
        }),
      );
    }
    if (sayNames) update['key'] = hashedRefileKey(key, await codec.namesHasher());
    tx.update(ref, update);
    return { result: 'sealed' };
  });
}

// ---- What assistants changed ----

/** update_note's and archive_note's summaries, built of fixed words only: they name no note. */
const FIXED_PART =
  "(?:Changed a note's [A-Za-z ,]+|Archived a note|Restored a note|Dismissed a recipe's failed import|Touched a note)";
const FIXED_SUMMARY = new RegExp(`^${FIXED_PART}(?:; ${FIXED_PART})*$`);

/**
 * An old entry's summary once the notes it names are sealed (Eric,
 * 2026-11-15: relabelled, not deleted): the labels a new entry uses for
 * a sealed note. Readers tell a few things from a summary's words, and
 * the relabel keeps each: whether an update_note changed text
 * (`summarySaysText`), an archive or restore (put back's flip), and a
 * project filed under (`rerouteNotes`). A summary of fixed words alone
 * stays as it is.
 */
export function relabelSummary(tool: string, summary: string, notes: number): string {
  if ((tool === 'update_note' || tool === 'archive_note') && FIXED_SUMMARY.test(summary)) {
    return summary;
  }
  const many = notes > 1 ? `${notes} sealed notes` : 'a sealed note';
  if (tool === PUT_BACK_TOOL) return `Put back a change to ${many}`;
  const parts = [
    summarySaysText(summary)
      ? notes > 1
        ? `Changed the text of ${many}`
        : "Changed a sealed note's text"
      : `Changed ${many}`,
  ];
  if (/\bArchived a note\b/.test(summary)) parts.push('Archived a note');
  if (/\bRestored a note\b/.test(summary)) parts.push('Restored a note');
  if (/\bfiled under\b/.test(summary)) parts.push('filed under a sealed project');
  return parts.join('; ');
}

const SEALED_FIELD_NAMES: ReadonlySet<string> = new Set(SEALED_FIELDS);

/**
 * Activity entry `id`: every note it names labelled "Sealed note", its
 * summary relabelled when it named them, and each field before that put
 * back restores: a sealed field's plain value sealed as that field of
 * that note (so it goes back as stored, as a new entry's does), and a
 * plain body hash keyed (of the same text, or of nothing when that text
 * is kept nowhere). An entry about reminders only is left: reminder
 * text stays plain (2026-11-14).
 */
export async function relabelEntry(
  db: Firestore,
  codec: NoteCodec,
  uid: string,
  id: string,
  dryRun: boolean,
): Promise<Unit> {
  const ref = db.doc(`${paths.activity(uid)}/${id}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { result: 'already' };
    const entry = snap.data()!;
    const notes = Array.isArray(entry['notes']) ? (entry['notes'] as Data[]) : [];
    if (!notes.length) return { result: 'already' };
    const relabel = namesInClear(notes);
    const work = notes.map((t) => {
      const before = t['before'] && typeof t['before'] === 'object' ? (t['before'] as Data) : {};
      return Object.keys(before).filter((k) =>
        k === 'body' ? plainHash(before[k]) : SEALED_FIELD_NAMES.has(k) && holdsPlain(before[k]),
      );
    });
    if (!relabel && work.every((w) => !w.length)) return { result: 'already' };
    let unkept = 0;
    const next: Data[] = [];
    for (const [i, t] of notes.entries()) {
      const noteId = String(t['id'] ?? '');
      const keys = work[i];
      if (!keys.length || !noteId) {
        next.push(relabel ? { ...t, title: SEALED_TITLE } : t);
        continue;
      }
      const before = { ...(t['before'] as Data) };
      if (keys.includes('body')) {
        const raw = await tx.get(db.doc(paths.note(uid, noteId)));
        const note = raw.exists ? await NoteSnap.open(codec, raw) : undefined;
        const body = note && !note.locked ? String(note.get('body') ?? '') : undefined;
        const keyed = await keyedInPlace(tx, db, codec, uid, noteId, String(before['body']), body);
        before['body'] = keyed.hash;
        if (keyed.unkept) unkept++;
      }
      const fields = keys.filter((k) => k !== 'body') as SealedField[];
      if (fields.length && !dryRun) {
        const plain: Data = Object.fromEntries(fields.map((f) => [f, before[f]]));
        const written = await sealFields(
          codec,
          noteId,
          plain,
          await codec.forms(),
          new Set(fields),
        );
        for (const f of fields) {
          await opensBack(
            codec,
            noteId,
            f,
            fieldValue(written, f),
            await openedBefore(codec, noteId, f, before[f]),
          );
          before[f] = written[f];
        }
      }
      next.push({ ...t, ...(relabel ? { title: SEALED_TITLE } : {}), before });
    }
    if (dryRun) return { result: 'sealed', unkept };
    const update: Data = { notes: next };
    if (relabel) {
      update['summary'] = relabelSummary(
        String(entry['tool'] ?? ''),
        String(entry['summary'] ?? ''),
        notes.length,
      );
    }
    tx.update(ref, update);
    return { result: 'sealed', unkept };
  });
}

/** A field before as its text: a list's sealed elements opened as that field of that note. */
async function openedBefore(codec: NoteCodec, noteId: string, field: SealedField, value: unknown) {
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => codec.open(noteId, field, String(v))));
  }
  return value;
}
