import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  HABIT_DAY_KEYS,
  HABIT_ID,
  HABIT_NAME_MAX,
  Habit,
  HabitEntry,
  type HabitAnswer,
  type HabitDayState,
  type HabitSchedule,
  type HabitStreak,
  addDays,
  autoId,
  canLogHabitDay,
  habitDayKey,
  habitDue,
  habitEntries,
  habitLogId,
  habitLogMonths,
  habitMonth,
  habitPeriod,
  habitPeriodState,
  habitStreak,
  habitStrip,
  paths,
  zonedDay,
} from '@mossgoblin/schema';
import {
  type Firestore,
  Timestamp,
  collection,
  deleteField,
  doc,
  onSnapshot,
  setDoc,
} from 'firebase/firestore';
import { AuthService } from '../auth.service';
import { FIREBASE } from '../firebase';
import { ModulesService } from '../modules/modules.service';
import { NOW, RANDOM_BYTES, TIME_ZONE } from '../platform/platform';
import { TICK_MS, UNDO_MS } from '../reminders/reminders.service';

/** A habit as the app shows it; times in milliseconds. */
export interface HabitRecord {
  id: string;
  name: string;
  schedule: HabitSchedule;
  /** "HH:MM", local; none: any time. */
  time?: string;
  answer: HabitAnswer;
  archived: boolean;
  createdAt?: number;
}

/** One stored check-in, as read: its state, and the rest kept as it came. */
type RawEntry = Record<string, unknown> & { state: 'done' | 'skipped' };

/** A habit placed on a day: how it stands, its strip, and what can be logged. */
export interface PlacedHabit extends HabitRecord {
  /** Due on the day (`habitDue`). */
  due: boolean;
  /** How the period holding the day stands: done, skipped, or nothing yet. */
  state: 'done' | 'skipped' | 'none';
  /** The day's own entry, if any. */
  today?: 'done' | 'skipped';
  /** Yesterday's own entry, if any. */
  yesterday?: 'done' | 'skipped';
  /**
   * Yesterday can still be logged and is a period of its own (a daily
   * habit, or the first day of a week or month): the habit was there
   * then. Logged or not; `yesterdayOpen` says whether it is empty.
   */
  yesterdayLoggable: boolean;
  /** Loggable, and nothing in yesterday's period yet. */
  yesterdayOpen: boolean;
  strip: { day: string; state: HabitDayState }[];
  /** The streak, once the months it needs are read; undefined until then. */
  streak?: HabitStreak;
}

/** What was just logged, offered back as Undo. */
export interface HabitUndoable {
  habit: string;
  day: string;
  message: string;
  /** The entry before, as it was stored; none: there was none. */
  before?: RawEntry;
}

/**
 * A write the server refused (review of #327, 2026-11-21), shown until
 * the same thing is next saved or the gardener dismisses it: one day of
 * a habit's log, or the habit itself.
 */
export interface HabitRefusal {
  /** What was written: `log:<habit>:<day>` or `habit:<habit>`. */
  key: string;
  habit: string;
  /** The day, for a log write. */
  day?: string;
  /** The habit's name when it was written. */
  name: string;
  /** "Floss could not be saved for today." */
  message: string;
}

/** What a write is about, for saying so if it is refused. */
interface About {
  key: string;
  habit: string;
  day?: string;
  name: string;
  kind: 'log' | 'add' | 'change';
}

/** The Firestore calls the service makes, as a seam for unit specs. */
export interface HabitsApi {
  /** Every habit, archived ones too (their history stays visible). */
  listenHabits(
    db: Firestore,
    path: string,
    next: (docs: { id: string; data: Record<string, unknown> }[]) => void,
    error: (err: unknown) => void,
  ): () => void;
  /** One month log, by its derived id; undefined while it does not exist. */
  listenLog(
    db: Firestore,
    path: string,
    next: (data: Record<string, unknown> | undefined) => void,
    error: (err: unknown) => void,
  ): () => void;
  set(db: Firestore, path: string, data: Record<string, unknown>, merge: boolean): Promise<void>;
  /** Marks a field for removal in a merged write. */
  remove(): unknown;
  timestamp(ms: number): unknown;
}

export const HABITS_API = new InjectionToken<HabitsApi>('habits-api', {
  providedIn: 'root',
  factory: () => ({
    listenHabits: (db, path, next, error) =>
      onSnapshot(
        collection(db, path),
        (snap) => next(snap.docs.map((d) => ({ id: d.id, data: d.data() }))),
        error,
      ),
    listenLog: (db, path, next, error) =>
      onSnapshot(doc(db, path), (snap) => next(snap.exists() ? snap.data() : undefined), error),
    set: (db, path, data, merge) => setDoc(doc(db, path), data, { merge }),
    remove: () => deleteField(),
    timestamp: (ms) => Timestamp.fromMillis(ms),
  }),
});

/** A new habit from the add form: a name, and a time of day if any. */
export interface NewHabit {
  name: string;
  /** "HH:MM", local. */
  time?: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function millis(v: unknown): number | undefined {
  return (v as { toMillis?: () => number } | undefined)?.toMillis?.();
}

/**
 * A stored habit as the app shows it, or undefined when it does not
 * parse against the schema (or its id is not a habit's): such a
 * document is passed over, never fatal to the list.
 */
function toRecord(id: string, data: Record<string, unknown>): HabitRecord | undefined {
  if (!HABIT_ID.test(id)) return undefined;
  const parsed = Habit.safeParse(data);
  if (!parsed.success) return undefined;
  const h = parsed.data;
  return {
    id,
    name: h.name,
    schedule: h.schedule,
    ...(h.time !== undefined ? { time: h.time } : {}),
    answer: h.answer,
    archived: h.archived,
    createdAt: millis(data['createdAt']),
  };
}

/**
 * The entries of a stored log, by day key, read entry by entry: each
 * day of the month that parses as a `HabitEntry` is kept, as stored
 * (so Undo can put it back); a day the month lacks, or an entry that
 * does not parse, is dropped, never the month with it.
 */
function readDays(
  data: Record<string, unknown> | undefined,
  month: string,
): Record<string, RawEntry> {
  const days = data?.['days'];
  const out: Record<string, RawEntry> = {};
  if (!days || typeof days !== 'object') return out;
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (const [key, entry] of Object.entries(days as Record<string, unknown>)) {
    if (!HABIT_DAY_KEYS.includes(key) || Number(key) > last) continue;
    if (HabitEntry.safeParse(entry).success) out[key] = entry as RawEntry;
  }
  return out;
}
/** A write, and what it is about; held while the gardener is not yet known. */
interface Waiting {
  path: (uid: string) => string;
  data: Record<string, unknown>;
  merge: boolean;
  about: About;
}

/**
 * Habits (#324, step 2): the gardener's habits and the month logs they
 * need, live, through the Firestore persistent cache; and the writes,
 * never awaited, so a tick works offline. Only while the module is on:
 * off, nothing is read. Today is the device's own day (`zonedDay` in
 * its zone, as Right Now decides today), rechecked as Right Now's clock
 * ticks, so a day that ends while the app is open moves on with it.
 *
 * A habit reads the month logs `habitLogMonths` names, at most two;
 * where a screen shows the streak (`showStreaks`) and it ran past the
 * first of them (`complete: false`), one month more, and so on, never
 * before the month the habit began.
 *
 * A write made before the gardener is known (a session still being
 * restored) is held and written once he is, as a choice made then is
 * for the theme; signed out, it is let go.
 *
 * A write the server refuses (review of #327, 2026-11-21) is undone in
 * the cache by Firestore, so the tick goes from the screen; it is said
 * in `refusals`, with Try again (the same write, sent again) and
 * Dismiss, never retried by itself. A write waiting offline never
 * settles, so it says nothing.
 */
@Injectable({ providedIn: 'root' })
export class HabitsService {
  private readonly fb = inject(FIREBASE);
  private readonly api = inject(HABITS_API);
  private readonly auth = inject(AuthService);
  private readonly modules = inject(ModulesService);
  private readonly random = inject(RANDOM_BYTES);
  private readonly now = inject(NOW);
  private readonly tz = inject(TIME_ZONE);

  /** Every habit, archived ones too, by name. */
  readonly habits = signal<HabitRecord[]>([]);
  /** Whether the habits have been heard from the cache or the server. */
  readonly loaded = signal(false);
  readonly undoable = signal<HabitUndoable | null>(null);
  /** The time the day is read from; ticks while the app is open. */
  readonly clock = signal(this.now());
  /** Today, on the device's own clock and in its zone. */
  readonly today = computed(() => zonedDay(this.clock(), this.tz));
  readonly yesterday = computed(() => addDays(this.today(), -1));

  /** The month logs heard, by id; a log that does not exist is `{}`. */
  private readonly logs = signal<Record<string, Record<string, RawEntry>>>({});
  /** The extra months read back for a habit's streak, by habit. */
  private readonly extra = signal<Record<string, number>>({});
  /** How many screens show the streak now. */
  private readonly streakViewers = signal(0);
  private readonly listening = new Map<string, () => void>();
  private readonly waiting: Waiting[] = [];
  /** Refused writes, by key, with the write to send again. */
  private readonly refused = signal<{ about: About; write: Waiting }[]>([]);
  private uid?: string;
  private stopHabits?: () => void;
  private undoTimer?: ReturnType<typeof setTimeout>;

  private readonly weekStart = computed(() => this.modules.habitsConfig().weekStart);

  /** The months each habit needs, oldest first. */
  private readonly months = computed(() => {
    const today = this.today();
    const extra = this.extra();
    const out = new Map<string, string[]>();
    for (const h of this.habits()) {
      const months = habitLogMonths(h.schedule, today, this.weekStart());
      for (let i = 0; i < (extra[h.id] ?? 0); i++) {
        months.unshift(habitMonth(addDays(`${months[0]}-01`, -1)));
      }
      out.set(h.id, months);
    }
    return out;
  });

  /** Refused writes, worded against today, oldest first. */
  readonly refusals = computed<HabitRefusal[]>(() => {
    const today = this.today();
    const yesterday = this.yesterday();
    return this.refused().map(({ about }) => {
      const { kind, day, name } = about;
      const when = day === today ? 'today' : day === yesterday ? 'yesterday' : day;
      const message =
        kind === 'log'
          ? `${name} could not be saved for ${when}.`
          : kind === 'add'
            ? `${name} could not be saved.`
            : `The change to ${name} could not be saved.`;
      return {
        key: about.key,
        habit: about.habit,
        ...(day !== undefined ? { day } : {}),
        name,
        message,
      };
    });
  });

  /** Every habit placed on today, archived ones too, by time then name. */
  readonly placed = computed<PlacedHabit[]>(() => {
    const today = this.today();
    const yesterday = this.yesterday();
    const weekStart = this.weekStart();
    const logs = this.logs();
    const months = this.months();
    return this.habits()
      .map((h) => {
        const ids = (months.get(h.id) ?? []).map((m) => habitLogId(h.id, m));
        const read = ids.every((id) => id in logs);
        const entries = habitEntries(
          ids
            .filter((id) => id in logs)
            .map((id) => ({
              month: id.slice(-7),
              days: logs[id] as unknown as Record<string, HabitEntry>,
            })),
        );
        const createdOn = h.createdAt === undefined ? undefined : zonedDay(h.createdAt, this.tz);
        const yesterdayLoggable =
          canLogHabitDay(yesterday, today) &&
          habitPeriod(h.schedule, yesterday, weekStart).start !==
            habitPeriod(h.schedule, today, weekStart).start &&
          (createdOn === undefined || createdOn <= yesterday);
        const firstMonth = months.get(h.id)?.[0];
        const loadedFrom =
          firstMonth && !(createdOn && habitMonth(createdOn) >= firstMonth)
            ? `${firstMonth}-01`
            : undefined;
        return {
          ...h,
          due: habitDue(h, entries, today, weekStart),
          state: habitPeriodState(h, entries, today, weekStart),
          today: entries.get(today)?.state,
          yesterday: entries.get(yesterday)?.state,
          yesterdayLoggable,
          yesterdayOpen:
            yesterdayLoggable && habitPeriodState(h, entries, yesterday, weekStart) === 'none',
          strip: habitStrip(h, entries, today, { weekStart, createdOn }),
          ...(read ? { streak: habitStreak(h, entries, today, { weekStart, loadedFrom }) } : {}),
        };
      })
      .sort(
        (a, b) =>
          (a.time ?? '99:99').localeCompare(b.time ?? '99:99') ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      );
  });

  /** The habits not archived, as the Habits screen lists them. */
  readonly active = computed(() => this.placed().filter((h) => !h.archived));
  /** Archived habits, their history still shown. */
  readonly archived = computed(() => this.placed().filter((h) => h.archived));
  /** Due today, nothing logged in its period yet: Right Now's list. */
  readonly toDo = computed(() => this.placed().filter((h) => h.due && h.state === 'none'));
  /** Due today and done or skipped today: Right Now's line under it. */
  readonly settled = computed(() => this.placed().filter((h) => h.due && h.state !== 'none'));

  constructor() {
    // The habits, while signed in with the module on.
    effect(() => {
      const uid = this.auth.user()?.uid;
      const on = this.modules.habits();
      const key = uid && on ? uid : undefined;
      untracked(() => this.follow(key));
    });
    // The month logs the habits need, as they change.
    effect(() => {
      const months = this.months();
      untracked(() => this.listenLogs(months));
    });
    // A streak that ran past what is read, on a screen that shows it.
    effect(() => {
      if (this.streakViewers() === 0) return;
      const more = this.placed().filter((h) => h.streak && !h.streak.complete);
      if (!more.length) return;
      untracked(() =>
        this.extra.update((e) => {
          const next = { ...e };
          for (const h of more) next[h.id] = (next[h.id] ?? 0) + 1;
          return next;
        }),
      );
    });
    // Writes made before the gardener was known.
    effect(() => {
      const user = this.auth.user();
      untracked(() => {
        if (user === null) this.waiting.length = 0;
        else if (user) for (const w of this.waiting.splice(0)) this.send(user.uid, w);
      });
    });
    const tick = setInterval(() => this.clock.set(this.now()), TICK_MS);
    inject(DestroyRef).onDestroy(() => {
      this.follow(undefined);
      clearInterval(tick);
      clearTimeout(this.undoTimer);
    });
  }

  /** A screen showing streaks; call the result when it goes. */
  showStreaks(): () => void {
    this.streakViewers.update((n) => n + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.streakViewers.update((n) => n - 1);
    };
  }

  /** Adds a daily, done-only habit; a name past HABIT_NAME_MAX is cut. */
  add(input: NewHabit): string | undefined {
    const name = input.name.trim().slice(0, HABIT_NAME_MAX).trim();
    if (!name) return undefined;
    const now = this.now();
    const id = autoId(this.random);
    const data: Record<string, unknown> = {
      name,
      schedule: 'daily',
      tz: this.tz,
      answer: 'done',
      nudge: false,
      archived: false,
      createdAt: this.api.timestamp(now),
      updatedAt: this.api.timestamp(now),
      createdBy: 'user',
    };
    if (input.time && TIME.test(input.time)) data['time'] = input.time;
    this.write({
      path: (uid) => paths.habit(uid, id),
      data,
      merge: false,
      about: { key: `habit:${id}`, habit: id, name, kind: 'add' },
    });
    this.clock.set(now);
    return id;
  }

  rename(id: string, name: string): void {
    const trimmed = name.trim().slice(0, HABIT_NAME_MAX).trim();
    if (!trimmed) return;
    this.update(id, { name: trimmed });
  }

  /** A time of day, "HH:MM", or none (any time); the zone becomes the device's. */
  setTime(id: string, time: string | undefined): void {
    if (time !== undefined && !TIME.test(time)) return;
    this.update(id, { time: time ?? this.api.remove(), tz: this.tz });
  }

  archive(id: string, archived: boolean): void {
    this.update(id, { archived });
  }

  /**
   * Logs `day` (today, or yesterday after the fact) as done or skipped,
   * with Undo; a merged write of that one day to the month's log.
   */
  log(habit: HabitRecord, day: string, state: 'done' | 'skipped'): void {
    if (!canLogHabitDay(day, this.today())) return;
    const before = this.entry(habit.id, day);
    const at = this.now();
    this.writeDay(habit.id, day, {
      state,
      at: this.api.timestamp(at),
      answer: this.api.remove(),
      noteId: this.api.remove(),
    });
    const when = day === this.today() ? '' : ' yesterday';
    this.offerUndo({
      habit: habit.id,
      day,
      message: `${habit.name}: ${state === 'done' ? 'done' : 'skipped'}${when}`,
      before,
    });
  }

  /** Clears a day's check-in. */
  clear(habit: HabitRecord, day: string): void {
    if (!canLogHabitDay(day, this.today())) return;
    const before = this.entry(habit.id, day);
    if (!before) return;
    this.writeDay(habit.id, day, undefined);
    const when = day === this.today() ? 'today' : 'yesterday';
    this.offerUndo({ habit: habit.id, day, message: `${habit.name}: cleared ${when}`, before });
  }

  /** Puts the day back as it was before the last log or clear. */
  undo(): void {
    const last = this.undoable();
    if (!last) return;
    this.undoable.set(null);
    clearTimeout(this.undoTimer);
    if (!last.before) {
      this.writeDay(last.habit, last.day, undefined);
      return;
    }
    const restored: Record<string, unknown> = {
      answer: this.api.remove(),
      noteId: this.api.remove(),
      ...last.before,
    };
    this.writeDay(last.habit, last.day, restored);
  }

  /** Sends a refused write again; refused again, it says so again. */
  retry(key: string): void {
    const found = this.refused().find((r) => r.about.key === key);
    if (!found) return;
    this.dismiss(key);
    this.write(found.write);
  }

  /** Puts a refused write's line away; the write is not sent again. */
  dismiss(key: string): void {
    this.refused.update((list) => list.filter((r) => r.about.key !== key));
  }

  /** The stored entry for a habit's day, as it was heard. */
  private entry(habit: string, day: string): RawEntry | undefined {
    return this.logs()[habitLogId(habit, habitMonth(day))]?.[habitDayKey(day)];
  }

  private offerUndo(u: HabitUndoable): void {
    this.undoable.set(u);
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => this.undoable.set(null), UNDO_MS);
  }

  /** Writes one day of a month log, or removes it with `entry` undefined. */
  private writeDay(habit: string, day: string, entry: Record<string, unknown> | undefined): void {
    const month = habitMonth(day);
    const id = habitLogId(habit, month);
    this.write({
      path: (uid) => paths.habitLog(uid, id),
      data: {
        habit,
        month,
        days: { [habitDayKey(day)]: entry ?? this.api.remove() },
        updatedAt: this.api.timestamp(this.now()),
      },
      merge: true,
      about: { key: `log:${habit}:${day}`, habit, day, name: this.nameOf(habit), kind: 'log' },
    });
  }

  private update(id: string, change: Record<string, unknown>): void {
    this.write({
      path: (uid) => paths.habit(uid, id),
      data: { ...change, updatedAt: this.api.timestamp(this.now()) },
      merge: true,
      about: { key: `habit:${id}`, habit: id, name: this.nameOf(id), kind: 'change' },
    });
  }

  private nameOf(id: string): string {
    return this.habits().find((h) => h.id === id)?.name ?? 'A habit';
  }

  private write(w: Waiting): void {
    const user = this.auth.user();
    if (user === null) return;
    if (user === undefined) {
      this.waiting.push(w);
      return;
    }
    this.send(user.uid, w);
  }

  /**
   * Sends a write, never awaited. Saved, it clears a refusal of the
   * same thing; refused, it says so, and a refused day takes its Undo
   * with it, the tick it offered to undo being gone.
   */
  private send(uid: string, w: Waiting): void {
    const key = w.about.key;
    this.api.set(this.fb.db, w.path(uid), w.data, w.merge).then(
      () => {
        if (this.auth.user()?.uid === uid) this.dismiss(key);
      },
      (err) => {
        console.error('habit write failed', err);
        if (this.auth.user()?.uid !== uid) return;
        this.refused.update((list) => [
          ...list.filter((r) => r.about.key !== key),
          { about: w.about, write: w },
        ]);
        const last = this.undoable();
        if (w.about.kind === 'log' && last?.habit === w.about.habit && last.day === w.about.day) {
          this.undoable.set(null);
          clearTimeout(this.undoTimer);
        }
      },
    );
  }

  /** Listens to `uid`'s habits, or to nothing. */
  private follow(uid: string | undefined): void {
    if (uid === this.uid) return;
    this.stopHabits?.();
    this.stopHabits = undefined;
    for (const stop of this.listening.values()) stop();
    this.listening.clear();
    this.uid = uid;
    this.habits.set([]);
    this.logs.set({});
    this.extra.set({});
    this.loaded.set(false);
    this.undoable.set(null);
    this.refused.set([]);
    if (!uid) return;
    this.stopHabits = this.api.listenHabits(
      this.fb.db,
      paths.habits(uid),
      (docs) => {
        this.habits.set(
          docs.flatMap((d) => {
            const h = toRecord(d.id, d.data);
            return h ? [h] : [];
          }),
        );
        this.loaded.set(true);
      },
      (err) => console.error('habits listener', err),
    );
  }

  /** Listens to exactly the month logs `months` names, by their derived ids. */
  private listenLogs(months: ReadonlyMap<string, string[]>): void {
    const uid = this.uid;
    const wanted = new Set<string>();
    if (uid) {
      for (const [habit, list] of months) for (const m of list) wanted.add(habitLogId(habit, m));
    }
    for (const [id, stop] of this.listening) {
      if (wanted.has(id)) continue;
      stop();
      this.listening.delete(id);
      this.logs.update((l) => {
        const { [id]: _gone, ...rest } = l;
        return rest;
      });
    }
    if (!uid) return;
    for (const id of wanted) {
      if (this.listening.has(id)) continue;
      this.listening.set(
        id,
        this.api.listenLog(
          this.fb.db,
          paths.habitLog(uid, id),
          (data) => this.logs.update((l) => ({ ...l, [id]: readDays(data, id.slice(-7)) })),
          (err) => console.error('habit log listener', err),
        ),
      );
    }
  }
}
