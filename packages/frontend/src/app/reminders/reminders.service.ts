import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  type Recurrence,
  type ReminderStatus,
  type ReminderTimes,
  type Section,
  autoId,
  effectiveDue,
  firstOccurrence,
  markDone,
  paths,
  sectionOf,
  snoozeUntil,
} from '@mossgoblin/schema';
import {
  type Firestore,
  Timestamp,
  collection,
  deleteField,
  doc,
  onSnapshot,
  query,
  setDoc,
  where,
} from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { NOW, RANDOM_BYTES, TIME_ZONE } from '../platform/platform';

/** A reminder as Right Now shows it; times in milliseconds. */
export interface ReminderRecord {
  id: string;
  text: string;
  status: ReminderStatus;
  dueAt?: number;
  snoozedUntil?: number;
  nextFireAt?: number;
  recurrence?: Recurrence;
  noteId?: string;
  createdBy: 'user' | 'claude';
}

/** A reminder placed in Right Now: its section and when it is due. */
export interface PlacedReminder extends ReminderRecord {
  due?: number;
  section: Section;
}

/** The Firestore calls the service makes, as a seam for unit specs. */
export interface RemindersApi {
  /** Open and snoozed reminders; done ones are never listed. */
  listen(
    db: Firestore,
    path: string,
    next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    error: (err: unknown) => void,
  ): () => void;
  set(db: Firestore, path: string, data: Record<string, unknown>, merge: boolean): Promise<void>;
  /** Marks a field for removal in a merged write. */
  remove(): unknown;
  timestamp(ms: number): unknown;
}

export const REMINDERS_API = new InjectionToken<RemindersApi>('reminders-api', {
  providedIn: 'root',
  factory: () => ({
    listen: (db, path, next, error) =>
      onSnapshot(
        query(collection(db, path), where('status', 'in', ['open', 'snoozed'])),
        (snap) => next(snap.docs.map((d) => ({ id: d.id, data: d.data() }))),
        error,
      ),
    set: (db, path, data, merge) => setDoc(doc(db, path), data, { merge }),
    remove: () => deleteField(),
    timestamp: (ms) => Timestamp.fromMillis(ms),
  }),
});

/** How often Right Now re-sorts, so items slide into Overdue on time. */
export const TICK_MS = 30_000;
export const UNDO_MS = 6_000;

/** What the user just did, offered back as Undo. */
export interface Undoable {
  id: string;
  message: string;
  before: ReminderTimes;
}

/** New reminder input from the add form. */
export interface NewReminder {
  text: string;
  /** Milliseconds, or undefined for Someday. */
  dueAt?: number;
  repeat?: Recurrence['freq'];
  /** The note it belongs to: a project's task (#41). */
  noteId?: string;
}

function millis(v: unknown): number | undefined {
  return (v as { toMillis?: () => number } | undefined)?.toMillis?.();
}

function toRecord(id: string, data: Record<string, unknown>): ReminderRecord {
  return {
    id,
    text: String(data['text'] ?? ''),
    status: (data['status'] as ReminderStatus) ?? 'open',
    dueAt: millis(data['dueAt']),
    snoozedUntil: millis(data['snoozedUntil']),
    nextFireAt: millis(data['nextFireAt']),
    recurrence: data['recurrence'] as Recurrence | undefined,
    noteId: typeof data['noteId'] === 'string' ? data['noteId'] : undefined,
    createdBy: data['createdBy'] === 'claude' ? 'claude' : 'user',
  };
}

/**
 * The signed-in user's open reminders, placed in Right Now's sections,
 * and the writes: add, done, snooze and undo. Like notes, writes go
 * through the persistent cache and are never awaited, so done and
 * snooze work offline.
 */
@Injectable({ providedIn: 'root' })
export class RemindersService {
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(REMINDERS_API);
  private readonly auth = inject(AuthService);
  private readonly random = inject(RANDOM_BYTES);
  private readonly now = inject(NOW);
  private readonly tz = inject(TIME_ZONE);

  readonly reminders = signal<ReminderRecord[]>([]);
  /** Whether writes can happen: the user is known. Until then Add waits. */
  readonly ready = computed(() => !!this.auth.user()?.uid);
  readonly undoable = signal<Undoable | null>(null);
  /** The time Right Now is sorted at; ticks while the app is open. */
  readonly clock = signal(this.now());

  /** Every open reminder, soonest first, Someday last (by text). */
  readonly placed = computed<PlacedReminder[]>(() => {
    const now = this.clock();
    return this.reminders()
      .map((r) => {
        const due = effectiveDue(r);
        return { ...r, due, section: sectionOf(due, now, this.tz) };
      })
      .sort(
        (a, b) =>
          (a.due ?? Infinity) - (b.due ?? Infinity) ||
          a.text.localeCompare(b.text) ||
          a.id.localeCompare(b.id),
      );
  });

  /** What needs doing now: overdue and the rest of today. */
  readonly due = computed(() =>
    this.placed().filter((r) => r.section === 'overdue' || r.section === 'today'),
  );

  private uid?: string;
  private stop?: () => void;
  private undoTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      const uid = this.auth.user()?.uid;
      if (uid === this.uid) return;
      this.stop?.();
      this.stop = undefined;
      this.uid = uid;
      this.reminders.set([]);
      this.undoable.set(null);
      if (!uid) return;
      this.stop = this.api.listen(
        this.fb.db,
        paths.reminders(uid),
        (docs) => this.reminders.set(docs.map((d) => toRecord(d.id, d.data))),
        (err) => console.error('reminders listener', err),
      );
    });
    const tick = setInterval(() => this.clock.set(this.now()), TICK_MS);
    inject(DestroyRef).onDestroy(() => {
      this.stop?.();
      clearInterval(tick);
      clearTimeout(this.undoTimer);
    });
  }

  /** Adds a reminder; a repeat with no time starts at 9 am. */
  add(input: NewReminder): void {
    const text = input.text.trim();
    if (!this.uid || !text) return;
    const now = this.now();
    let dueAt = input.dueAt;
    let recurrence: Recurrence | undefined;
    if (input.repeat) {
      recurrence = {
        freq: input.repeat,
        time: dueAt === undefined ? '09:00' : this.localTime(dueAt),
        tz: this.tz,
      };
      dueAt ??= firstOccurrence(recurrence, now);
    }
    const data: Record<string, unknown> = { text, status: 'open', createdBy: 'user' };
    if (dueAt !== undefined) {
      data['dueAt'] = this.api.timestamp(dueAt);
      data['nextFireAt'] = this.api.timestamp(dueAt);
    }
    if (recurrence) data['recurrence'] = recurrence;
    if (input.noteId) data['noteId'] = input.noteId;
    const id = autoId(this.random);
    this.write(id, data, false);
    this.clock.set(now);
  }

  done(r: ReminderRecord): void {
    this.change(r, markDone(r, this.now()), r.recurrence ? 'Done until next time' : 'Done');
  }

  snooze(r: ReminderRecord, until: number): void {
    this.change(r, snoozeUntil(r, until), 'Snoozed');
  }

  undo(): void {
    const last = this.undoable();
    if (!last) return;
    this.undoable.set(null);
    clearTimeout(this.undoTimer);
    this.apply(last.id, last.before);
  }

  private change(r: ReminderRecord, next: ReminderTimes, message: string): void {
    const before: ReminderTimes = {
      status: r.status,
      dueAt: r.dueAt,
      snoozedUntil: r.snoozedUntil,
      nextFireAt: r.nextFireAt,
    };
    this.apply(r.id, next);
    this.undoable.set({ id: r.id, message, before });
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => this.undoable.set(null), UNDO_MS);
  }

  /** Writes the time fields, removing the ones `times` leaves out. */
  private apply(id: string, times: ReminderTimes): void {
    const field = (ms: number | undefined) =>
      ms === undefined ? this.api.remove() : this.api.timestamp(ms);
    this.write(
      id,
      {
        status: times.status,
        dueAt: field(times.dueAt),
        snoozedUntil: field(times.snoozedUntil),
        nextFireAt: field(times.nextFireAt),
      },
      true,
    );
  }

  private write(id: string, data: Record<string, unknown>, merge: boolean): void {
    if (!this.uid) return;
    const path = `${paths.reminders(this.uid)}/${id}`;
    this.api.set(this.fb.db, path, data, merge).catch((err) => {
      console.error('reminder write failed', err);
    });
  }

  private localTime(ms: number): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: this.tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(ms);
  }
}
