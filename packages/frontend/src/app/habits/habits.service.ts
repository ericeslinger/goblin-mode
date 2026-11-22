import {
  DestroyRef,
  Injectable,
  InjectionToken,
  Injector,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  type DataKey,
  HABIT_CHOICE_MAX,
  HABIT_DAY_KEYS,
  HABIT_ID,
  HABIT_NAME_MAX,
  HABIT_TEXT_MAX,
  Habit,
  HabitEntry,
  type HabitAnswer,
  type HabitAnswerKind,
  type HabitDayState,
  type HabitSchedule,
  type HabitStreak,
  addDays,
  autoId,
  canLogHabitDay,
  habitAnswerLine,
  habitChoicesProblem,
  habitDayKey,
  habitDayLoggable,
  habitDue,
  habitEntries,
  habitLogId,
  habitLogMonths,
  habitMonth,
  habitPeriodState,
  habitSettledOn,
  habitStreak,
  habitStrip,
  openHabitAnswer,
  paths,
  sealHabitAnswer,
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
import { NoteKeyService } from '../notes/note-key.service';
import { LocalStore } from '../platform/local-store';
import { NOW, RANDOM_BYTES, TIME_ZONE } from '../platform/platform';
import { Router } from '@angular/router';
import { CaptureService } from '../capture/capture.service';
import { TICK_MS, UNDO_MS } from '../reminders/reminders.service';
import { TemplatesService } from '../templates/templates.service';
import type { ShownAnswer } from './habit-lines';

/** A habit as the app shows it; times in milliseconds. */
export interface HabitRecord {
  id: string;
  name: string;
  schedule: HabitSchedule;
  /** "HH:MM", local; none: any time. */
  time?: string;
  /** One push at its time on a day not yet logged (step 4 of #324). */
  nudge: boolean;
  answer: HabitAnswer;
  /** A choice habit's list, in order (step 6 of #324). */
  choices?: string[];
  /** A note habit's template, by its note id (step 6 of #324). */
  template?: string;
  archived: boolean;
  createdAt?: number;
}

/**
 * A day's answer as shown (step 6 of #324, 2026-11-22): its text,
 * opened (`held` while it waits on this device for the note key, not
 * yet written); `sealed`, stored sealed and not opened here (no key, or
 * it does not open), left untouched; or the note an entry opened.
 */
export type HabitShownAnswer = ShownAnswer;

/** Where the answers waiting for the note key are kept on this device. */
export const HELD_ANSWERS_KEY = 'goblin.heldHabitAnswers';
/** Where a line of text being typed for a habit is kept, until it is saved. */
export const ANSWER_DRAFTS_KEY = 'goblin.habitAnswerDrafts';

/**
 * An answer held on this device for the note key: the tick was written
 * at once without it, at `at`; the answer is written sealed into that
 * same entry once the key is here, and let go if the entry changed.
 */
interface HeldAnswer {
  uid?: string;
  habit: string;
  day: string;
  kind: HabitAnswerKind;
  text: string;
  at: number;
}

/** What a tick answers with: a choice or a line of text, or the note it opened. */
export type HabitAnswerGiven = { text: string } | { noteId: string };

/** One stored check-in, as read: its state, and the rest kept as it came. */
type RawEntry = Record<string, unknown> & { state: 'done' | 'skipped' };

/** A habit placed on a day: how it stands, its strip, and what can be logged. */
export interface PlacedHabit extends HabitRecord {
  /** Due on the day (`habitDue`). */
  due: boolean;
  /** How the period holding the day stands: done, skipped, or nothing yet. */
  state: 'done' | 'skipped' | 'none';
  /** The day that settled that period (`habitSettledOn`), if it is. */
  settledOn?: string;
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
  /** The seven days ending today, each with its answer, if any. */
  strip: { day: string; state: HabitDayState; answer?: HabitShownAnswer }[];
  /** Today's answer, if any (step 6 of #324). */
  todayAnswer?: HabitShownAnswer;
  /** Yesterday's answer, if any. */
  yesterdayAnswer?: HabitShownAnswer;
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
  /** Its answer, if it was held on this device for the key then. */
  heldBefore?: HeldAnswer;
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

/** A new habit from the add form: a name, how often, and a time of day if any. */
export interface NewHabit {
  name: string;
  /** Daily unless given (step 5 of #324). */
  schedule?: HabitSchedule;
  /** "HH:MM", local. */
  time?: string;
  /** Done unless given (step 6 of #324), with its choices or its template. */
  answer?: HabitAnswer;
  choices?: string[];
  template?: string;
}

/**
 * What a habit is answered with, as the forms give it (step 6 of #324):
 * the fields to write, the others removed; undefined when it is not
 * one a habit can hold (a list with a problem, a note with no
 * template). Choices are cleaned to one line each.
 */
export function answerFields(
  answer: HabitAnswer,
  choices: readonly string[] | undefined,
  template: string | undefined,
): { answer: HabitAnswer; choices?: string[]; template?: string } | undefined {
  if (answer === 'choice') {
    const list = (choices ?? []).map((c) => habitAnswerLine(c, HABIT_CHOICE_MAX));
    return habitChoicesProblem(list) ? undefined : { answer, choices: list };
  }
  if (answer === 'note') return template ? { answer, template } : undefined;
  if (answer === 'done' || answer === 'text') return { answer };
  return undefined;
}

const SCHEDULES: readonly HabitSchedule[] = ['daily', 'weekly', 'monthly'];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * How old the clock may be and still be what the screen shows now: two
 * of its ticks. An older one stopped while the app was away (in the
 * background, or the device asleep), so the day on the screen is not
 * today's (review of #328, 2026-11-21).
 */
export const FRESH_MS = 2 * TICK_MS;

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
    nudge: h.nudge,
    answer: h.answer,
    ...(h.choices !== undefined ? { choices: h.choices } : {}),
    ...(h.template !== undefined ? { template: h.template } : {}),
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
 * ticks, so a day that ends while the app is open moves on with it,
 * and again whenever the app comes back to the screen. A tick reads the
 * clock afresh as it is made (`dayOf`, review of #328, 2026-11-21).
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
  private readonly keys = inject(NoteKeyService);
  private readonly store = inject(LocalStore);
  /** Templates and the editor only when a note habit is ticked. */
  private readonly injector = inject(Injector);
  /**
   * Answers held on this device for the note key (step 6 of #324), by
   * `{habit}_{day}`, as kept in HELD_ANSWERS_KEY, so a reload keeps them.
   */
  private readonly held = signal<Record<string, HeldAnswer>>(
    this.store.get<Record<string, HeldAnswer>>(HELD_ANSWERS_KEY) ?? {},
  );
  /** Answers opened, by uid, habit, day and sealed value; null: did not open. */
  private readonly opened = new Map<string, string | null>();
  private openedWith?: DataKey;

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

  /**
   * Of the months each habit needs, the newest run of them heard, oldest
   * first; empty while the newest is not (review of #328, 2026-11-21).
   */
  private readonly heard = computed(() => {
    const logs = this.logs();
    const out = new Map<string, { months: string[]; all: boolean }>();
    for (const [habit, months] of this.months()) {
      let i = months.length;
      while (i > 0 && habitLogId(habit, months[i - 1]) in logs) i--;
      out.set(habit, { months: months.slice(i), all: i === 0 });
    }
    return out;
  });

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
    const heard = this.heard();
    return this.habits()
      .map((h) => {
        const ids = (months.get(h.id) ?? []).map((m) => habitLogId(h.id, m));
        const entries = habitEntries(
          ids
            .filter((id) => id in logs)
            .map((id) => ({
              month: id.slice(-7),
              days: logs[id] as unknown as Record<string, HabitEntry>,
            })),
        );
        // The streak is counted on the newest months heard, so while a
        // further month is read back it stays as it was, `complete:
        // false` ("at least"); unknown only while the months the strip
        // needs are not all heard (review of #328, 2026-11-21).
        const run = heard.get(h.id)?.months ?? [];
        const base = habitLogMonths(h.schedule, today, weekStart).length;
        const read = run.length >= base;
        const createdOn = h.createdAt === undefined ? undefined : zonedDay(h.createdAt, this.tz);
        // The one test of a loggable day, the assistant's too (review of #329).
        const yesterdayLoggable = habitDayLoggable(h, yesterday, today, { weekStart, createdOn });
        const firstMonth = run[0];
        const loadedFrom =
          firstMonth && !(createdOn && habitMonth(createdOn) >= firstMonth)
            ? `${firstMonth}-01`
            : undefined;
        const settledOn = habitSettledOn(h, entries, today, weekStart);
        const answerOn = (day: string) => this.shownAnswer(h.id, day, entries.get(day));
        const todayAnswer = answerOn(today);
        const yesterdayAnswer = answerOn(yesterday);
        return {
          ...h,
          due: habitDue(h, entries, today, weekStart),
          state: habitPeriodState(h, entries, today, weekStart),
          ...(settledOn !== undefined ? { settledOn } : {}),
          today: entries.get(today)?.state,
          yesterday: entries.get(yesterday)?.state,
          yesterdayLoggable,
          yesterdayOpen:
            yesterdayLoggable && habitPeriodState(h, entries, yesterday, weekStart) === 'none',
          strip: habitStrip(h, entries, today, { weekStart, createdOn }).map((d) => {
            const answer = answerOn(d.day);
            return answer ? { ...d, answer } : d;
          }),
          ...(todayAnswer ? { todayAnswer } : {}),
          ...(yesterdayAnswer ? { yesterdayAnswer } : {}),
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
      const heard = this.heard();
      const more = this.placed().filter(
        (h) => h.streak && !h.streak.complete && heard.get(h.id)?.all,
      );
      if (!more.length) return;
      untracked(() =>
        this.extra.update((e) => {
          const next = { ...e };
          for (const h of more) next[h.id] = (next[h.id] ?? 0) + 1;
          return next;
        }),
      );
    });
    // Answers held for the note key, written sealed once it is here
    // and the entry they belong to has been heard (step 6 of #324).
    effect(() => {
      const key = this.keys.key();
      const user = this.auth.user();
      const held = this.held();
      this.logs();
      if (!key || !user || !Object.keys(held).length) return;
      untracked(() => this.writeHeld(key, user.uid));
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
    // Back on the screen, the day is read again at once: the tick above
    // does not run while the app is away (review of #328, 2026-11-21).
    const doc = inject(DOCUMENT);
    const back = () => {
      if (!doc.hidden) this.clock.set(this.now());
    };
    doc.addEventListener('visibilitychange', back);
    doc.defaultView?.addEventListener('pageshow', back);
    inject(DestroyRef).onDestroy(() => {
      doc.removeEventListener('visibilitychange', back);
      doc.defaultView?.removeEventListener('pageshow', back);
      this.follow(undefined);
      clearInterval(tick);
      clearTimeout(this.undoTimer);
    });
  }

  /**
   * A screen showing streaks; call the result when it goes. Once none
   * does, the months read back for them are let go (review of #328,
   * 2026-11-21).
   */
  showStreaks(): () => void {
    this.streakViewers.update((n) => n + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.streakViewers.update((n) => n - 1);
      if (this.streakViewers() === 0) this.extra.set({});
    };
  }

  /**
   * Adds a habit, daily unless a schedule is given (step 5 of #324),
   * done unless an answer is (step 6), with its choices or template; a
   * name past HABIT_NAME_MAX is cut. None is made for an answer it
   * cannot hold (`answerFields`).
   */
  add(input: NewHabit): string | undefined {
    const name = input.name.trim().slice(0, HABIT_NAME_MAX).trim();
    if (!name) return undefined;
    const answer = answerFields(input.answer ?? 'done', input.choices, input.template);
    if (!answer) return undefined;
    const now = this.now();
    const id = autoId(this.random);
    const data: Record<string, unknown> = {
      name,
      schedule: input.schedule && SCHEDULES.includes(input.schedule) ? input.schedule : 'daily',
      tz: this.tz,
      ...answer,
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

  /**
   * A time of day, "HH:MM", or none (any time); the zone becomes the
   * device's. The nudge is written with it, as a nudge needs a time:
   * with none, it is off.
   */
  setTime(id: string, time: string | undefined, nudge = false): void {
    if (time !== undefined && !TIME.test(time)) return;
    this.update(id, {
      time: time ?? this.api.remove(),
      tz: this.tz,
      nudge: time !== undefined && nudge,
    });
  }

  /**
   * The nudge on or off (step 4 of #324), its time and zone as they are;
   * on only with a time, as the rules hold.
   */
  setNudge(id: string, nudge: boolean): void {
    const h = this.habits().find((x) => x.id === id);
    if (nudge && h?.time === undefined) return;
    this.update(id, { nudge });
  }

  /**
   * How often (step 5 of #324, 2026-11-22): only the schedule is
   * written. The logs stay as they are and are read again by the new
   * schedule's periods, so nothing logged is lost and a change back
   * reads them as before. A nudge stays as it was, sent or not by
   * `habitNudgePlan`.
   */
  setSchedule(id: string, schedule: HabitSchedule): void {
    if (!SCHEDULES.includes(schedule)) return;
    this.update(id, { schedule });
  }

  /**
   * What a habit is answered with (step 6 of #324, 2026-11-22): its kind
   * and its choices or template, the other removed. The logs stay as
   * they are: every entry shows what it holds whatever the kind now (an
   * answer, opened; a note, its link), and a new tick asks for the new
   * kind's answer. Nothing for an answer the habit cannot hold.
   */
  setAnswer(id: string, answer: HabitAnswer, choices?: string[], template?: string): void {
    const fields = answerFields(answer, choices, template);
    if (!fields) return;
    this.update(id, {
      answer: fields.answer,
      choices: fields.choices ?? this.api.remove(),
      template: fields.template ?? this.api.remove(),
    });
  }

  archive(id: string, archived: boolean): void {
    this.update(id, { archived });
  }

  /**
   * Logs `shown` (the screen's today, or its yesterday after the fact)
   * as done or skipped, with Undo; a merged write of that one day to the
   * month's log, on the day `dayOf` makes of it.
   */
  log(
    habit: HabitRecord,
    shown: string,
    state: 'done' | 'skipped',
    answer?: HabitAnswerGiven,
  ): void {
    const day = this.dayOf(shown);
    if (day) this.logOn(habit, day, state, answer);
  }

  /**
   * A note habit's tick (step 6 of #324, 2026-11-22): a new entry from
   * its template, made as From template makes one (TemplatesService.use:
   * a living template's note, or a fresh entry), the day marked done at
   * the tap with the entry's note id, and the entry opened to write in,
   * the capture loop taking over. A template that is gone logs the day
   * done with no note. Returns the note opened, if one was.
   */
  logNote(habit: HabitRecord, shown: string): { id: string; text: string } | undefined {
    const day = this.dayOf(shown);
    if (!day) return undefined;
    // Lazily: the notes and the editor are not the Habits screen's own.
    const note = habit.template
      ? this.injector.get(TemplatesService).use(habit.template)
      : undefined;
    this.logOn(habit, day, 'done', note ? { noteId: note.id } : undefined);
    if (!note) return undefined;
    this.injector.get(CaptureService).openNote(note.id, note.text);
    void this.injector.get(Router).navigate(['/n', note.id]);
    return note;
  }

  /**
   * Logs `day` as `state` with `answer`. A choice or a line of text is
   * sealed with the note key before it is written, under the day's own
   * aad (`sealHabitAnswer`, padded); without the key on this device the
   * tick is written at once without it, and the answer is held here
   * (HELD_ANSWERS_KEY) and written into that entry, sealed, once the key
   * comes: it is never written plain, and a reload keeps it. A skip
   * holds no answer.
   */
  private logOn(
    habit: HabitRecord,
    day: string,
    state: 'done' | 'skipped',
    answer?: HabitAnswerGiven,
  ): void {
    const before = this.entry(habit.id, day);
    const heldBefore = this.held()[`${habit.id}_${day}`];
    const at = this.now();
    this.unhold(habit.id, day);
    this.dropDraft(habit.id, day);
    const entry: Record<string, unknown> = {
      state,
      at: this.api.timestamp(at),
      answer: this.api.remove(),
      noteId: this.api.remove(),
    };
    const kind: HabitAnswerKind = habit.answer === 'choice' ? 'choice' : 'text';
    const max = kind === 'choice' ? HABIT_CHOICE_MAX : HABIT_TEXT_MAX;
    const text =
      state === 'done' && answer && 'text' in answer ? habitAnswerLine(answer.text, max) : '';
    if (state === 'done' && answer && 'noteId' in answer) entry['noteId'] = answer.noteId;
    if (text) {
      const key = this.keys.key();
      const uid = this.auth.user()?.uid;
      if (key && uid) entry['answer'] = sealHabitAnswer(key, uid, habit.id, day, kind, text);
      else this.hold({ ...(uid ? { uid } : {}), habit: habit.id, day, kind, text, at });
    }
    this.writeDay(habit.id, day, entry);
    const when = day === this.today() ? '' : ' yesterday';
    const what = state === 'done' ? (kind === 'choice' && text ? text : 'done') : 'skipped';
    this.offerUndo({
      habit: habit.id,
      day,
      message: `${habit.name}: ${what}${when}`,
      before,
      ...(heldBefore ? { heldBefore } : {}),
    });
  }

  /** The line being typed for a habit's day, kept on this device until saved. */
  draft(habit: string, day: string): string {
    const all = this.store.get<Record<string, { uid?: string; text: string }>>(ANSWER_DRAFTS_KEY);
    const d = all?.[`${habit}_${day}`];
    return d && d.uid === this.auth.user()?.uid ? d.text : '';
  }

  /** Keeps what is typed for a habit's day, so a reload does not lose it. */
  setDraft(habit: string, day: string, text: string): void {
    if (!text) return this.dropDraft(habit, day);
    const all = this.store.get<Record<string, unknown>>(ANSWER_DRAFTS_KEY) ?? {};
    const uid = this.auth.user()?.uid;
    this.store.set(ANSWER_DRAFTS_KEY, {
      ...all,
      [`${habit}_${day}`]: { ...(uid ? { uid } : {}), text },
    });
  }

  dropDraft(habit: string, day: string): void {
    const all = this.store.get<Record<string, unknown>>(ANSWER_DRAFTS_KEY);
    if (!all || !(`${habit}_${day}` in all)) return;
    const { [`${habit}_${day}`]: _gone, ...rest } = all;
    this.store.set(ANSWER_DRAFTS_KEY, rest);
  }

  /**
   * A day's answer as shown: one held here for the key, on the tick it
   * was given with; else the stored one, opened with this device's key
   * (or `sealed` when there is none, or it does not open); else the
   * note the entry opened.
   */
  private shownAnswer(
    habit: string,
    day: string,
    raw: HabitEntry | undefined,
  ): HabitShownAnswer | undefined {
    if (!raw) return undefined;
    const held = this.held()[`${habit}_${day}`];
    if (
      held &&
      raw.state === 'done' &&
      raw.answer === undefined &&
      millis(raw.at) === held.at &&
      (held.uid === undefined || held.uid === this.uid)
    ) {
      return { text: held.text, held: true };
    }
    if (typeof raw.answer === 'string') {
      const text = this.open(habit, day, raw.answer);
      return text === null ? { sealed: true } : { text };
    }
    if (typeof raw.noteId === 'string') return { noteId: raw.noteId };
    return undefined;
  }

  /** A stored answer's text, or null when this device cannot open it. */
  private open(habit: string, day: string, sealed: string): string | null {
    const key = this.keys.key();
    const uid = this.uid;
    if (!key || !uid) return null;
    if (key !== this.openedWith) {
      this.opened.clear();
      this.openedWith = key;
    }
    const at = `${uid}|${habit}|${day}|${sealed}`;
    let text = this.opened.get(at);
    if (text === undefined) {
      try {
        text = openHabitAnswer(key, uid, habit, day, sealed);
      } catch {
        text = null;
      }
      this.opened.set(at, text);
    }
    return text;
  }

  private hold(answer: HeldAnswer): void {
    this.setHeld({ ...this.held(), [`${answer.habit}_${answer.day}`]: answer });
  }

  private unhold(habit: string, day: string): void {
    const all = this.held();
    if (!(`${habit}_${day}` in all)) return;
    const { [`${habit}_${day}`]: _gone, ...rest } = all;
    this.setHeld(rest);
  }

  private setHeld(next: Record<string, HeldAnswer>): void {
    this.held.set(next);
    this.store.set(HELD_ANSWERS_KEY, next);
  }

  /**
   * The answers held for the key, now that it is here: each written,
   * sealed, into the entry it was given with, as a merged write of that
   * day's `answer` alone, once the day's log is heard and the entry is
   * still that tick (done at the same moment, with no answer); let go
   * when the entry has changed since (undone, skipped, answered on
   * another device). Another gardener's are left as they are.
   */
  private writeHeld(key: DataKey, uid: string): void {
    for (const h of Object.values(this.held())) {
      if (h.uid !== undefined && h.uid !== uid) continue;
      const logId = habitLogId(h.habit, habitMonth(h.day));
      if (!(logId in this.logs())) continue;
      const raw = this.entry(h.habit, h.day);
      this.unhold(h.habit, h.day);
      if (!raw || raw.state !== 'done' || raw['answer'] !== undefined) continue;
      if (raw['noteId'] !== undefined || millis(raw['at']) !== h.at) continue;
      const answer = sealHabitAnswer(key, uid, h.habit, h.day, h.kind, h.text);
      this.writeDay(h.habit, h.day, { answer });
    }
  }

  /** Clears a day's check-in, the day as `dayOf` makes it. */
  clear(habit: HabitRecord, shown: string): void {
    const day = this.dayOf(shown);
    if (!day) return;
    const before = this.entry(habit.id, day);
    if (!before) return;
    const heldBefore = this.held()[`${habit.id}_${day}`];
    this.unhold(habit.id, day);
    this.writeDay(habit.id, day, undefined);
    const when = day === this.today() ? 'today' : 'yesterday';
    this.offerUndo({
      habit: habit.id,
      day,
      message: `${habit.name}: cleared ${when}`,
      before,
      ...(heldBefore ? { heldBefore } : {}),
    });
  }

  /** Puts the day back as it was before the last log or clear. */
  undo(): void {
    const last = this.undoable();
    if (!last) return;
    this.undoable.set(null);
    clearTimeout(this.undoTimer);
    this.unhold(last.habit, last.day);
    // An answer that was waiting for the key waits again, on its tick.
    if (last.heldBefore) this.hold(last.heldBefore);
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

  /**
   * The day a tap means, the clock read afresh as it is made (review of
   * #328, 2026-11-21); none when that day can no longer be logged. With
   * the clock still fresh (`FRESH_MS`), the screen was showing the day
   * it was tapped on, so it means that day, even if midnight came
   * between: a tick at 00:00:05 on a row that said today at 23:59:50
   * goes to that day, yesterday now and still loggable. With a stale
   * clock (the app was away, and the screen not yet redrawn) the screen
   * showed a day that has gone, so its today means today and its
   * yesterday yesterday.
   */
  private dayOf(shown: string): string | undefined {
    const now = this.now();
    const fresh = now - this.clock() <= FRESH_MS;
    const was = { today: this.today(), yesterday: this.yesterday() };
    this.clock.set(now);
    const day = fresh
      ? shown
      : shown === was.today
        ? this.today()
        : shown === was.yesterday
          ? this.yesterday()
          : shown;
    return canLogHabitDay(day, this.today()) ? day : undefined;
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
