// What Claude can do through the MCP connector (DESIGN.md, MCP server),
// as plain functions over the owner's Firestore data. Every write is
// checked against the zod contract before it lands; notes Claude writes
// carry updatedBy 'claude' and deviceId 'claude', so noteHistory keeps
// the version Claude replaced.
import {
  Note,
  type Recurrence,
  Reminder,
  autoId,
  effectiveDue,
  firstOccurrence,
  firstWordsTitle,
  markDone,
  matchesSearch,
  paths,
  snoozeUntil,
} from '@goblin/schema';
import { FieldValue, type Firestore, Timestamp } from 'firebase-admin/firestore';
import { randomFillSync } from 'node:crypto';

export const CLAUDE_DEVICE = 'claude';
const LIST_LIMIT = 50;

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

export class NotesTools {
  constructor(
    private readonly db: Firestore,
    private readonly uid: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private notes() {
    return this.db.collection(paths.notes(this.uid));
  }
  private reminders() {
    return this.db.collection(paths.reminders(this.uid));
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
    const backlinks = await this.notes().where('links', 'array-contains', args.id).get();
    return {
      id: doc.id,
      title: d['title'],
      titleSource: d['titleSource'],
      body: d['body'],
      tags: d['tags'] ?? [],
      links: d['links'] ?? [],
      backlinks: backlinks.docs.map((b) => ({ id: b.id, title: b.get('title') })),
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
      links: [],
      tags: args.tags ?? [],
      archived: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: 'claude',
      deviceId: CLAUDE_DEVICE,
    });
    const id = autoId((bytes) => void randomFillSync(bytes));
    await this.notes().doc(id).set(data);
    return { id, title: data.title };
  }

  async updateNote(args: {
    id: string;
    body?: string;
    title?: string;
    tags?: string[];
    archived?: boolean;
  }) {
    const ref = this.notes().doc(args.id);
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
      return {
        id: args.id,
        updated: Object.keys(update).filter((k) => !k.startsWith('updated') && k !== 'deviceId'),
      };
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
    const id = autoId((bytes) => void randomFillSync(bytes));
    await this.reminders().doc(id).set(data);
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
