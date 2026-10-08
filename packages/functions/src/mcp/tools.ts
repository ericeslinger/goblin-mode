// What Claude can do through the MCP connector (DESIGN.md, MCP server),
// as plain functions over the owner's Firestore data. Every write is
// checked against the zod contract before it lands; notes Claude writes
// carry updatedBy 'claude' and deviceId 'claude', so noteHistory keeps
// the version Claude replaced. Every write also records an activity
// entry in the same commit, shown in the app as What Claude changed.
import { findWikiLinks, parseNote, wikiLinkTargets } from '@mossgoblin/editor/grammar';
import {
  Activity,
  type ConceptType,
  Note,
  type Touched,
  type Recurrence,
  Reminder,
  autoId,
  conceptId,
  effectiveDue,
  firstOccurrence,
  firstWordsTitle,
  markDone,
  matchesSearch,
  nameIndex,
  normalizeName,
  paths,
  resolveLinks,
  sentenceAround,
  snoozeUntil,
  templateParts,
  textHash,
} from '@mossgoblin/schema';
import {
  type DocumentReference,
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { randomFillSync } from 'node:crypto';
import type { RawProposal } from '../organize/proposals';
import { storeSuggestions } from '../organize/store';
import { addLines, setItem } from './lines';
import { cutsOf, joined } from './verbatim';

export const CLAUDE_DEVICE = 'claude';
const LIST_LIMIT = 50;
/** The most notes one split or merge may make or take. */
const MAX_PIECES = 20;

/** A tool failed for a reason Claude should see and can act on. */
export class ToolError extends Error {}

const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined);
const iso = (v: unknown) => {
  const ms = millis(v);
  return ms === undefined ? undefined : new Date(ms).toISOString();
};

function parseTime(value: string, field: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new ToolError(`${field} must be an ISO 8601 time with an offset`);
  return ms;
}

function snippet(body: string, length = 200): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

type Data = Record<string, unknown>;

/** What the name index needs of a stored note. */
function named(id: string, d: Data) {
  return {
    id,
    title: String(d['title'] ?? ''),
    kind: typeof d['kind'] === 'string' ? d['kind'] : 'text',
    synonyms: Array.isArray(d['synonyms']) ? d['synonyms'].map(String) : undefined,
    archived: d['archived'] === true,
  };
}

/** The `[[names]]` in a body, as raw targets. */
const targetsOf = (body: string) => wikiLinkTargets(parseNote(body));

const newId = () => autoId((bytes) => void randomFillSync(bytes));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const touched = (id: string, d: Data): Touched => ({ id, title: String(d['title'] ?? '') });

/** A name that can sit inside `[[...]]` as it is. */
const linkable = (name: string) => !/\[\[|\]\]|\||\n/.test(name) && name.trim() !== '';

function noteSummary(id: string, d: Data) {
  return {
    id,
    title: String(d['title'] ?? ''),
    snippet: snippet(String(d['body'] ?? '')),
    tags: (d['tags'] as string[]) ?? [],
    updatedAt: iso(d['updatedAt']),
    updatedBy: d['updatedBy'],
    archived: d['archived'] === true,
  };
}

function reminderView(id: string, d: Data) {
  const times = {
    status: d['status'] as 'open' | 'done' | 'snoozed',
    dueAt: millis(d['dueAt']),
    snoozedUntil: millis(d['snoozedUntil']),
  };
  const due = effectiveDue(times);
  return {
    id,
    text: d['text'],
    status: times.status,
    dueAt: iso(d['dueAt']),
    snoozedUntil: iso(d['snoozedUntil']),
    nextDue: due === undefined ? undefined : new Date(due).toISOString(),
    recurrence: d['recurrence'],
    noteId: d['noteId'],
    createdBy: d['createdBy'],
  };
}

/** Fields done, snooze and a new time change, as Firestore values. */
function timesData(t: {
  status: string;
  dueAt?: number;
  snoozedUntil?: number;
  nextFireAt?: number;
}) {
  const field = (ms?: number) =>
    ms === undefined ? FieldValue.delete() : Timestamp.fromMillis(ms);
  return {
    status: t.status,
    dueAt: field(t.dueAt),
    snoozedUntil: field(t.snoozedUntil),
    nextFireAt: field(t.nextFireAt),
  };
}

/** Drops FieldValue.delete() entries, to validate the document as it will be. */
function withoutDeletes(d: Data): Data {
  return Object.fromEntries(Object.entries(d).filter(([, v]) => !(v instanceof FieldValue)));
}

/** The longest concept name, and the most other names or tags, create_concept takes. */
const MAX_NAME = 120;
const MAX_NAMES = 20;

/** Trimmed, non-empty, each once (by its normalized form). */
function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((v) => v.trim())
    .filter((v) => {
      const key = normalizeName(v);
      if (!v || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export class NotesTools {
  constructor(
    private readonly db: Firestore,
    private readonly uid: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private notes() {
    return this.db.collection(paths.notes(this.uid));
  }
  /** Names to ids across the gardener's notes (schema, concepts.ts). */
  private async names(): Promise<Map<string, string>> {
    // Names only: no bodies.
    const snap = await this.notes().select('title', 'kind', 'synonyms', 'archived').get();
    return nameIndex(snap.docs.map((doc) => named(doc.id, doc.data())));
  }

  private reminders() {
    return this.db.collection(paths.reminders(this.uid));
  }

  /** Every note, with the name index over them (bodies included). */
  private async garden() {
    const snap = await this.notes().get();
    const docs = snap.docs.map((doc) => ({ id: doc.id, data: doc.data() as Data }));
    return { docs, index: nameIndex(docs.map((d) => named(d.id, d.data))) };
  }

  /**
   * The activity entry for a run, as a `set` for the run's own batch or
   * transaction, so the change and its record land together.
   */
  private activity(
    tool: string,
    summary: string,
    notes: Touched[],
    reminders: Touched[] = [],
  ): [DocumentReference, Data] {
    const data = Activity.parse({
      at: Timestamp.fromMillis(this.now()),
      tool,
      summary,
      notes,
      reminders,
    });
    return [this.db.collection(paths.activity(this.uid)).doc(newId()), data];
  }

  /** The fields every note write by Claude carries. */
  private stamp(): Data {
    return {
      updatedAt: Timestamp.fromMillis(this.now()),
      updatedBy: 'claude',
      deviceId: CLAUDE_DEVICE,
    };
  }

  async searchNotes(args: { query: string; includeArchived?: boolean; limit?: number }) {
    const snap = await this.notes().orderBy('updatedAt', 'desc').get();
    const hits = snap.docs.filter((doc) => {
      const d = doc.data();
      if (d['archived'] === true && !args.includeArchived) return false;
      return matchesSearch(
        { title: String(d['title'] ?? ''), body: String(d['body'] ?? ''), synonyms: d['synonyms'] },
        args.query,
      );
    });
    return hits.slice(0, args.limit ?? LIST_LIMIT).map((doc) => noteSummary(doc.id, doc.data()));
  }

  async listNotes(args: { since?: string; limit?: number; includeArchived?: boolean }) {
    let q = this.notes().orderBy('updatedAt', 'desc');
    if (args.since)
      q = q.where('updatedAt', '>=', Timestamp.fromMillis(parseTime(args.since, 'since')));
    const snap = await q.get();
    return snap.docs
      .filter((doc) => args.includeArchived || doc.get('archived') !== true)
      .slice(0, args.limit ?? LIST_LIMIT)
      .map((doc) => noteSummary(doc.id, doc.data()));
  }

  async getNote(args: { id: string }) {
    const doc = await this.notes().doc(args.id).get();
    if (!doc.exists) throw new ToolError(`no note ${args.id}`);
    const d = doc.data()!;
    // Read from bodies, not stored links, so notes written before links
    // were stored (#28) count too. Every body is parsed: fine for one
    // gardener's notes; once all notes carry links, an array-contains
    // query on `links` can replace the scan.
    const all = await this.notes().get();
    const index = nameIndex(all.docs.map((n) => named(n.id, n.data())));
    const backlinks = all.docs.filter(
      (n) =>
        n.id !== args.id &&
        resolveLinks(targetsOf(String(n.get('body') ?? '')), index).includes(args.id),
    );
    return {
      id: doc.id,
      title: d['title'],
      titleSource: d['titleSource'],
      body: d['body'],
      tags: d['tags'] ?? [],
      links: d['links'] ?? [],
      backlinks: backlinks.map((b) => ({ id: b.id, title: b.get('title') })),
      archived: d['archived'] === true,
      createdAt: iso(d['createdAt']),
      updatedAt: iso(d['updatedAt']),
      updatedBy: d['updatedBy'],
    };
  }

  async createNote(args: { body: string; title?: string; tags?: string[] }) {
    if (!args.body.trim()) throw new ToolError('body must not be empty');
    const now = Timestamp.fromMillis(this.now());
    const data = Note.parse({
      kind: 'text',
      body: args.body,
      title: args.title?.trim() || firstWordsTitle(args.body),
      titleSource: args.title?.trim() ? 'llm' : 'words',
      links: resolveLinks(targetsOf(args.body), await this.names()),
      tags: args.tags ?? [],
      archived: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'claude',
      deviceId: CLAUDE_DEVICE,
    });
    const id = newId();
    const batch = this.db.batch();
    batch.set(this.notes().doc(id), data);
    batch.set(...this.activity('create_note', 'Wrote a new note', [touched(id, data)]));
    await batch.commit();
    return { id, title: data.title };
  }

  /**
   * A new concept (a person, project or other named thing), with the id
   * the app would give it, so `[[name]]` links find it. Refused when the
   * name or another of its names is already a note's.
   */
  async createConcept(args: {
    name: string;
    type?: ConceptType;
    synonyms?: string[];
    body?: string;
    tags?: string[];
  }) {
    const name = args.name.trim();
    if (!name) throw new ToolError('name must not be empty');
    if (name.length > MAX_NAME) throw new ToolError(`a name is at most ${MAX_NAME} characters`);
    const key = normalizeName(name);
    const synonyms = unique(args.synonyms ?? []).filter((s) => normalizeName(s) !== key);
    const tags = unique(args.tags ?? []);
    if (synonyms.length > MAX_NAMES || tags.length > MAX_NAMES)
      throw new ToolError(`at most ${MAX_NAMES} other names and ${MAX_NAMES} tags`);
    if (synonyms.some((s) => s.length > MAX_NAME))
      throw new ToolError(`a name is at most ${MAX_NAME} characters`);
    const names = await this.names();
    const id = conceptId(name);
    const taken = [name, ...synonyms].filter((n) => names.has(normalizeName(n)));
    if (taken.length) throw new ToolError(`already a name in the garden: ${taken.join(', ')}`);
    const now = Timestamp.fromMillis(this.now());
    const body = args.body ?? '';
    const data = Note.parse({
      kind: 'concept',
      body,
      title: name,
      // A concept's name is Eric's: a settle never retitles it.
      titleSource: 'user',
      conceptType: args.type ?? 'other',
      synonyms,
      links: resolveLinks(targetsOf(body), names),
      tags,
      archived: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'claude',
      deviceId: CLAUDE_DEVICE,
    });
    const ref = this.notes().doc(id);
    await this.db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) throw new ToolError(`${name} is already a concept (${id})`);
      tx.set(ref, data);
      tx.set(
        ...this.activity(
          'create_concept',
          `Made ${data.title} a ${data.conceptType === 'other' ? 'concept' : data.conceptType}`,
          [touched(id, data)],
        ),
      );
    });
    return { id, title: data.title, type: data.conceptType };
  }

  async updateNote(args: {
    id: string;
    body?: string;
    title?: string;
    tags?: string[];
    archived?: boolean;
  }) {
    const ref = this.notes().doc(args.id);
    const names = args.body === undefined ? undefined : await this.names();
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new ToolError(`no note ${args.id}`);
      const current = doc.data()!;
      const update: Data = {
        updatedAt: Timestamp.fromMillis(this.now()),
        updatedBy: 'claude',
        deviceId: CLAUDE_DEVICE,
      };
      if (args.body !== undefined) {
        if (!args.body.trim())
          throw new ToolError('body must not be empty; archive the note instead');
        update['body'] = args.body;
        update['baseHash'] = textHash(String(current['body'] ?? ''));
        update['links'] = resolveLinks(targetsOf(args.body), names!);
        if (current['titleSource'] === 'words' && args.title === undefined) {
          update['title'] = firstWordsTitle(args.body);
        }
      }
      if (args.title !== undefined) {
        // Eric's own title is his; Claude may only propose one in chat.
        if (current['titleSource'] === 'user')
          throw new ToolError("the title is Eric's own; leave it");
        update['title'] = args.title;
        update['titleSource'] = 'llm';
      }
      if (args.tags !== undefined) update['tags'] = args.tags;
      if (args.archived !== undefined) update['archived'] = args.archived;
      Note.parse({ ...current, ...update });
      tx.update(ref, update);
      const changed = [
        args.body !== undefined && 'text',
        args.title !== undefined && 'title',
        args.tags !== undefined && 'tags',
      ].filter((x): x is string => !!x);
      const parts = [
        changed.length > 0 &&
          `Changed a note's ${changed.join(' and ').replace(/ and (?=.* and )/, ', ')}`,
        args.archived === true && 'Archived a note',
        args.archived === false && 'Restored a note',
      ].filter((x): x is string => !!x);
      tx.set(
        ...this.activity('update_note', parts.join('; ') || 'Touched a note', [
          touched(args.id, { ...current, ...update }),
        ]),
      );
      return {
        id: args.id,
        updated: Object.keys(update).filter((k) => !k.startsWith('updated') && k !== 'deviceId'),
      };
    });
  }

  async listConcepts(args: { type?: ConceptType }) {
    const { docs, index } = await this.garden();
    const counts = new Map<string, number>();
    for (const d of docs) {
      if (d.data['archived'] === true) continue;
      for (const id of resolveLinks(targetsOf(String(d.data['body'] ?? '')), index)) {
        if (id !== d.id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return docs
      .filter((d) => d.data['kind'] === 'concept' && d.data['archived'] !== true)
      .filter((d) => !args.type || (d.data['conceptType'] ?? 'other') === args.type)
      .map((d) => ({
        id: d.id,
        title: String(d.data['title'] ?? ''),
        type: (d.data['conceptType'] as string | undefined) ?? 'other',
        synonyms: (d.data['synonyms'] as string[] | undefined) ?? [],
        linkedFrom: counts.get(d.id) ?? 0,
      }))
      .sort((a, b) => b.linkedFrom - a.linkedFrom || a.title.localeCompare(b.title));
  }

  async getBacklinks(args: { id: string }) {
    const { docs, index } = await this.garden();
    return docs
      .filter((d) => d.id !== args.id && d.data['archived'] !== true)
      .flatMap((d) => {
        const body = String(d.data['body'] ?? '');
        if (!resolveLinks(targetsOf(body), index).includes(args.id)) return [];
        const span = findWikiLinks(body).find(
          (w) => resolveLinks([w.target], index)[0] === args.id,
        );
        return [
          {
            id: d.id,
            title: String(d.data['title'] ?? ''),
            sentence: span ? sentenceAround(body, span.start, span.end) : '',
            updatedAt: iso(d.data['updatedAt']),
          },
        ];
      })
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  async linkNotes(args: { from: string; to: string[] }) {
    const { index } = await this.garden();
    const refs = [args.from, ...args.to].map((id) => this.notes().doc(id));
    return this.db.runTransaction(async (tx) => {
      const snaps = await tx.getAll(...refs);
      for (const snap of snaps) {
        if (!snap.exists) throw new ToolError(`no note ${snap.id}`);
        if (snap.get('archived') === true) throw new ToolError(`note ${snap.id} is archived`);
      }
      const [from, ...tos] = snaps;
      const current = from.data()!;
      const body = String(current['body'] ?? '');
      const linked = new Set(resolveLinks(targetsOf(body), index));
      const names: string[] = [];
      const added: Touched[] = [];
      for (const to of tos) {
        if (to.id === from.id) throw new ToolError('a note cannot link to itself');
        if (linked.has(to.id)) continue;
        linked.add(to.id);
        const d = to.data()!;
        const name = [String(d['title'] ?? ''), ...((d['synonyms'] as string[]) ?? [])].find(
          (n) => linkable(n) && index.get(normalizeName(n)) === to.id,
        );
        if (!name) {
          throw new ToolError(
            `nothing links to ${to.id} by name: its title is empty or names another note; ` +
              'give it its own title first',
          );
        }
        names.push(name);
        added.push(touched(to.id, d));
      }
      if (names.length === 0) return { id: from.id, linked: [] };
      // Claude's own line, under the gardener's text, which stays as it is.
      const next = `${body.trimEnd()}\n\nSee also ${names.map((n) => `[[${n}]]`).join(', ')}`;
      const update: Data = {
        ...this.stamp(),
        body: next,
        baseHash: textHash(body),
        links: resolveLinks(targetsOf(next), index),
      };
      Note.parse({ ...current, ...update });
      tx.update(from.ref, update);
      tx.set(
        ...this.activity('link_notes', `Linked a note to ${plural(names.length, 'other')}`, [
          touched(from.id, current),
          ...added,
        ]),
      );
      return { id: from.id, linked: added };
    });
  }

  async splitNote(args: { id: string; parts: string[] }) {
    if (args.parts.length < 2 || args.parts.length > MAX_PIECES)
      throw new ToolError(`split into 2 to ${MAX_PIECES} parts`);
    const { docs } = await this.garden();
    const ref = this.notes().doc(args.id);
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new ToolError(`no note ${args.id}`);
      const current = doc.data()!;
      if (current['archived'] === true) throw new ToolError(`note ${args.id} is archived`);
      if (current['kind'] !== 'text') throw new ToolError('only a text note can be split');
      const cuts = cutsOf(String(current['body'] ?? ''), args.parts);
      if (typeof cuts === 'string') throw new ToolError(cuts);
      const [first, ...rest] = cuts;
      const now = Timestamp.fromMillis(this.now());
      const pieces = rest.map((body) => ({
        id: newId(),
        data: {
          kind: 'text',
          body,
          title: firstWordsTitle(body),
          titleSource: 'words',
          tags: (current['tags'] as string[]) ?? [],
          archived: false,
          createdAt: now,
          ...this.stamp(),
        } as Data,
      }));
      const index = nameIndex([
        ...docs.map((d) => named(d.id, d.data)),
        ...pieces.map((p) => named(p.id, p.data)),
      ]);
      // Link the pieces from what is left, where their names reach them.
      const names = pieces
        .map((p) => String(p.data['title']))
        .filter((t, i) => linkable(t) && index.get(normalizeName(t)) === pieces[i].id);
      const body = names.length
        ? `${first}\n\nSplit off: ${names.map((n) => `[[${n}]]`).join(', ')}`
        : first;
      const update: Data = {
        ...this.stamp(),
        body,
        baseHash: textHash(String(current['body'] ?? '')),
        links: resolveLinks(targetsOf(body), index),
      };
      if (current['titleSource'] === 'words') update['title'] = firstWordsTitle(body);
      Note.parse({ ...current, ...update });
      tx.update(ref, update);
      for (const p of pieces) {
        p.data['links'] = resolveLinks(targetsOf(String(p.data['body'])), index);
        tx.set(this.notes().doc(p.id), Note.parse(p.data));
      }
      tx.set(
        ...this.activity('split_note', `Split a note into ${cuts.length}`, [
          touched(args.id, { ...current, ...update }),
          ...pieces.map((p) => touched(p.id, p.data)),
        ]),
      );
      return {
        id: args.id,
        pieces: pieces.map((p) => ({ id: p.id, title: p.data['title'] })),
      };
    });
  }

  async mergeNotes(args: { ids: string[]; title?: string }) {
    const ids = [...new Set(args.ids)];
    if (ids.length < 2 || ids.length > MAX_PIECES)
      throw new ToolError(`merge 2 to ${MAX_PIECES} different notes`);
    const { docs } = await this.garden();
    const refs = ids.map((id) => this.notes().doc(id));
    return this.db.runTransaction(async (tx) => {
      const snaps = await tx.getAll(...refs);
      for (const snap of snaps) {
        if (!snap.exists) throw new ToolError(`no note ${snap.id}`);
        if (snap.get('archived') === true) throw new ToolError(`note ${snap.id} is archived`);
        if (snap.get('kind') !== 'text') throw new ToolError('only text notes can be merged');
      }
      const originals = snaps.map((s) => ({ id: s.id, data: s.data()! }));
      const first = originals[0].data;
      const body = joined(originals.map((o) => String(o.data['body'] ?? '')));
      const title = args.title?.trim()
        ? { title: args.title.trim(), titleSource: 'llm' }
        : first['titleSource'] === 'user'
          ? { title: first['title'], titleSource: 'user' }
          : { title: firstWordsTitle(body), titleSource: 'words' };
      // The originals' names, so links to them follow the merge.
      const synonyms = [
        ...new Map(
          originals
            .flatMap((o) => [
              String(o.data['title'] ?? ''),
              ...((o.data['synonyms'] as string[]) ?? []),
            ])
            .filter((n) => n.trim() && normalizeName(n) !== normalizeName(String(title.title)))
            .map((n) => [normalizeName(n), n.trim()]),
        ).values(),
      ];
      const created = originals
        .map((o) => o.data['createdAt'])
        .filter((t): t is Timestamp => t instanceof Timestamp)
        .sort((a, b) => a.toMillis() - b.toMillis())[0];
      const id = newId();
      const merged: Data = {
        kind: 'text',
        body,
        ...title,
        ...(synonyms.length ? { synonyms } : {}),
        tags: [...new Set(originals.flatMap((o) => (o.data['tags'] as string[]) ?? []))],
        archived: false,
        createdAt: created ?? Timestamp.fromMillis(this.now()),
        ...this.stamp(),
      };
      const gone = new Set(ids);
      const index = nameIndex([
        ...docs.filter((d) => !gone.has(d.id)).map((d) => named(d.id, d.data)),
        named(id, merged),
      ]);
      // One original linking another now names the merged note itself.
      merged['links'] = resolveLinks(targetsOf(body), index).filter((l) => l !== id);
      tx.set(this.notes().doc(id), Note.parse(merged));
      for (const o of originals) {
        const update = { ...this.stamp(), archived: true, mergedInto: id };
        Note.parse({ ...o.data, ...update });
        tx.update(this.notes().doc(o.id), update);
      }
      tx.set(
        ...this.activity('merge_notes', `Merged ${plural(ids.length, 'note')} into one`, [
          touched(id, merged),
          ...originals.map((o) => touched(o.id, o.data)),
        ]),
      );
      return { id, title: merged['title'], archived: ids };
    });
  }

  async refile(args: {
    id: string;
    type?: ConceptType;
    addSynonyms?: string[];
    addTags?: string[];
    removeTags?: string[];
  }) {
    const { index } = await this.garden();
    const ref = this.notes().doc(args.id);
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new ToolError(`no note ${args.id}`);
      const current = doc.data()!;
      const concept = current['kind'] === 'concept';
      if (!concept && (args.type || args.addSynonyms?.length))
        throw new ToolError('only a concept has a type and other names');
      const update: Data = {};
      const said: string[] = [];
      if (args.type && args.type !== (current['conceptType'] ?? 'other')) {
        update['conceptType'] = args.type;
        said.push(`filed as ${args.type === 'other' ? 'a concept' : `a ${args.type}`}`);
      }
      const refused: string[] = [];
      if (args.addSynonyms?.length) {
        const synonyms = [...((current['synonyms'] as string[]) ?? [])];
        const have = new Set([String(current['title']), ...synonyms].map(normalizeName));
        const added: string[] = [];
        for (const raw of args.addSynonyms) {
          const name = raw.trim();
          const key = normalizeName(name);
          if (!key || have.has(key)) continue;
          const owner = index.get(key);
          if (owner && owner !== args.id) {
            refused.push(name);
            continue;
          }
          have.add(key);
          synonyms.push(name);
          added.push(name);
        }
        if (added.length) {
          update['synonyms'] = synonyms;
          said.push(
            `added ${added.length === 1 ? 'another name' : 'other names'}: ${added.join(', ')}`,
          );
        }
      }
      if (args.addTags?.length || args.removeTags?.length) {
        const before = (current['tags'] as string[]) ?? [];
        const drop = new Set(args.removeTags ?? []);
        const tags = [...new Set([...before, ...(args.addTags ?? []).map((t) => t.trim())])].filter(
          (t) => t && !drop.has(t),
        );
        const plus = tags.filter((t) => !before.includes(t));
        const minus = before.filter((t) => !tags.includes(t));
        if (plus.length || minus.length) {
          update['tags'] = tags;
          if (plus.length) said.push(`tagged ${plus.join(', ')}`);
          if (minus.length) said.push(`untagged ${minus.join(', ')}`);
        }
      }
      if (said.length === 0) return { id: args.id, changed: [], refused };
      Object.assign(update, this.stamp());
      Note.parse({ ...current, ...update });
      tx.update(ref, update);
      const what = `Refiled ${String(current['title'] ?? '') || 'a note'}: ${said.join('; ')}`;
      tx.set(...this.activity('refile', what, [touched(args.id, current)]));
      return { id: args.id, changed: said, refused };
    });
  }

  async archiveNote(args: { id: string; archived?: boolean }) {
    const archived = args.archived ?? true;
    const ref = this.notes().doc(args.id);
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new ToolError(`no note ${args.id}`);
      const current = doc.data()!;
      if ((current['archived'] === true) === archived) return { id: args.id, archived };
      const update = { ...this.stamp(), archived };
      Note.parse({ ...current, ...update });
      tx.update(ref, update);
      tx.set(
        ...this.activity('archive_note', archived ? 'Archived a note' : 'Restored a note', [
          touched(args.id, current),
        ]),
      );
      return { id: args.id, archived };
    });
  }

  /**
   * Suggestions for Eric to accept or dismiss in the app (#35); nothing
   * changes until he accepts. Checked and stored as proposals.
   */
  async suggestChanges(args: { proposals: RawProposal[] }) {
    const { stored, dropped, open } = await storeSuggestions(
      this.db,
      this.uid,
      args.proposals,
      this.now(),
    );
    return {
      stored: stored.map((p) => ({ id: p.id, kind: p.kind, notes: p.notes, reason: p.reason })),
      dropped,
      waiting: open,
    };
  }

  /** The templates, each with its instructions, mode and schedule (#38). */
  async listTemplates(_args: object = {}) {
    const snap = await this.notes().where('kind', '==', 'template').get();
    const schedules = await this.reminders().where('template', '!=', '').get();
    return snap.docs
      .filter((d) => d.get('archived') !== true)
      .map((d) => {
        const { skeleton, instructions } = templateParts(String(d.get('body') ?? ''));
        return {
          id: d.id,
          title: String(d.get('title') ?? ''),
          mode: d.get('templateMode') === 'living' ? 'living' : 'entry',
          instructions,
          skeleton,
          schedule: schedules.docs
            .filter((r) => r.get('template') === d.id)
            .map((r) => reminderView(r.id, r.data())),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * The note to work in for a template, with its instructions (#38): a
   * living template's one note (made the first time), or a new entry
   * from the skeleton. Notes made here record the template.
   */
  async useTemplate(args: { id: string }) {
    const doc = await this.notes().doc(args.id).get();
    if (!doc.exists || doc.get('kind') !== 'template' || doc.get('archived') === true)
      throw new ToolError(`no template ${args.id}`);
    const template = doc.data()!;
    const { skeleton, instructions } = templateParts(String(template['body'] ?? ''));
    const mode = template['templateMode'] === 'living' ? 'living' : 'entry';
    const about = { id: doc.id, title: String(template['title'] ?? ''), mode };
    if (mode === 'living') {
      const made = await this.notes().where('fromTemplate', '==', doc.id).get();
      const living = made.docs
        .filter((d) => d.get('archived') !== true)
        .sort((a, b) => (millis(b.get('updatedAt')) ?? 0) - (millis(a.get('updatedAt')) ?? 0))[0];
      if (living) {
        return {
          template: about,
          instructions,
          created: false,
          note: { id: living.id, title: living.get('title'), body: living.get('body') },
        };
      }
    }
    if (!skeleton.trim()) throw new ToolError('the template has no text to start a note from');
    const now = Timestamp.fromMillis(this.now());
    const data = Note.parse({
      kind: 'text',
      body: skeleton,
      title: firstWordsTitle(skeleton),
      titleSource: 'words',
      links: resolveLinks(targetsOf(skeleton), await this.names()),
      tags: [],
      fromTemplate: doc.id,
      archived: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'claude',
      deviceId: CLAUDE_DEVICE,
    });
    const id = newId();
    const batch = this.db.batch();
    batch.set(this.notes().doc(id), data);
    batch.set(
      ...this.activity('use_template', `Started a note from ${about.title || 'a template'}`, [
        touched(id, data),
      ]),
    );
    await batch.commit();
    return {
      template: about,
      instructions,
      created: true,
      note: { id, title: data.title, body: skeleton },
    };
  }

  /**
   * Changes a note's text in a transaction against its current text, so
   * a write made meanwhile (Eric ticking items) is never replaced (#37).
   * `edit` returns the new body and the run's summary, or nothing to do.
   */
  private async editBody(
    id: string,
    tool: string,
    edit: (body: string, title: string) => { body: string; summary: string } | undefined,
  ) {
    const ref = this.notes().doc(id);
    const names = await this.names();
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new ToolError(`no note ${id}`);
      const current = doc.data()!;
      if (current['archived'] === true) throw new ToolError(`note ${id} is archived`);
      const result = edit(String(current['body'] ?? ''), String(current['title'] ?? ''));
      if (!result) return { id, changed: false };
      const update: Data = {
        ...this.stamp(),
        body: result.body,
        baseHash: textHash(String(current['body'] ?? '')),
        links: resolveLinks(targetsOf(result.body), names),
      };
      if (current['titleSource'] === 'words') update['title'] = firstWordsTitle(result.body);
      Note.parse({ ...current, ...update });
      tx.update(ref, update);
      tx.set(...this.activity(tool, result.summary, [touched(id, current)]));
      return { id, changed: true, body: result.body };
    });
  }

  async addLines(args: { id: string; lines: string[]; heading?: string }) {
    const lines = args.lines.flatMap((l) => l.split('\n'));
    if (!lines.some((l) => l.trim())) throw new ToolError('lines must have some text');
    return this.editBody(args.id, 'add_lines', (body, title) => ({
      body: addLines(body, lines, args.heading),
      summary: `Added ${plural(lines.length, 'line')} to ${title || 'a note'}${
        args.heading ? `, under ${args.heading.replace(/^#+\s*/, '')}` : ''
      }`,
    }));
  }

  async checkItem(args: { id: string; item: string }) {
    return this.setItem(args, true);
  }

  async uncheckItem(args: { id: string; item: string }) {
    return this.setItem(args, false);
  }

  private setItem(args: { id: string; item: string }, done: boolean) {
    return this.editBody(args.id, done ? 'check_item' : 'uncheck_item', (body) => {
      const result = setItem(body, args.item, done);
      if (typeof result === 'string') throw new ToolError(result);
      if (!result.changed) return undefined;
      return { body: result.body, summary: `${done ? 'Ticked' : 'Unticked'} ${result.text}` };
    });
  }

  async listReminders(args: { includeDone?: boolean }) {
    const q = args.includeDone
      ? this.reminders()
      : this.reminders().where('status', 'in', ['open', 'snoozed']);
    const snap = await q.get();
    return snap.docs
      .map((doc) => reminderView(doc.id, doc.data()))
      .sort((a, b) => (a.nextDue ?? '~').localeCompare(b.nextDue ?? '~'));
  }

  async createReminder(args: {
    text: string;
    dueAt?: string;
    repeat?: Recurrence['freq'];
    timeZone?: string;
    noteId?: string;
  }) {
    let dueAt = args.dueAt === undefined ? undefined : parseTime(args.dueAt, 'dueAt');
    let recurrence: Recurrence | undefined;
    if (args.repeat) {
      if (!args.timeZone)
        throw new ToolError("timeZone (Eric's IANA zone) is required with repeat");
      const time = dueAt === undefined ? '09:00' : localTime(dueAt, args.timeZone);
      recurrence = { freq: args.repeat, time, tz: args.timeZone };
      dueAt ??= firstOccurrence(recurrence, this.now());
    }
    const data: Data = { text: args.text.trim(), status: 'open', createdBy: 'claude' };
    if (dueAt !== undefined) {
      data['dueAt'] = Timestamp.fromMillis(dueAt);
      data['nextFireAt'] = Timestamp.fromMillis(dueAt);
    }
    if (recurrence) data['recurrence'] = recurrence;
    if (args.noteId) data['noteId'] = args.noteId;
    Reminder.parse(data);
    const id = newId();
    const batch = this.db.batch();
    batch.set(this.reminders().doc(id), data);
    batch.set(
      ...this.activity(
        'create_reminder',
        'Made a reminder',
        [],
        [{ id, title: String(data['text']) }],
      ),
    );
    await batch.commit();
    return reminderView(id, data);
  }

  async updateReminder(args: {
    id: string;
    text?: string;
    dueAt?: string | null;
    done?: boolean;
    snoozeUntil?: string;
    noteId?: string;
  }) {
    const ref = this.reminders().doc(args.id);
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new ToolError(`no reminder ${args.id}`);
      const current = doc.data()!;
      const times = {
        status: current['status'] as 'open' | 'done' | 'snoozed',
        dueAt: millis(current['dueAt']),
        snoozedUntil: millis(current['snoozedUntil']),
        nextFireAt: millis(current['nextFireAt']),
        recurrence: current['recurrence'] as Recurrence | undefined,
      };
      let update: Data = {};
      if (args.text !== undefined) update['text'] = args.text.trim();
      if (args.noteId !== undefined) update['noteId'] = args.noteId;
      if (args.dueAt !== undefined) {
        const due = args.dueAt === null ? undefined : parseTime(args.dueAt, 'dueAt');
        update = { ...update, ...timesData({ status: 'open', dueAt: due, nextFireAt: due }) };
      }
      if (args.snoozeUntil !== undefined) {
        update = {
          ...update,
          ...timesData(snoozeUntil(times, parseTime(args.snoozeUntil, 'snoozeUntil'))),
        };
      }
      if (args.done) update = { ...update, ...timesData(markDone(times, this.now())) };
      const merged = withoutDeletes({ ...current, ...update });
      for (const [k, v] of Object.entries(update)) if (v instanceof FieldValue) delete merged[k];
      Reminder.parse(merged);
      tx.update(ref, update);
      const summary = args.done
        ? 'Marked a reminder done'
        : args.snoozeUntil !== undefined
          ? 'Snoozed a reminder'
          : args.dueAt !== undefined
            ? 'Moved a reminder'
            : 'Changed a reminder';
      tx.set(
        ...this.activity(
          'update_reminder',
          summary,
          [],
          [{ id: args.id, title: String(merged['text'] ?? '') }],
        ),
      );
      return reminderView(args.id, merged);
    });
  }
}

function localTime(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(ms);
  } catch {
    throw new ToolError(`unknown time zone ${tz}`);
  }
}
