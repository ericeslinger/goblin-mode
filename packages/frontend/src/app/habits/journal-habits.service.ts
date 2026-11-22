import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  HABIT_ID,
  HABIT_NAME_MAX,
  type HabitsConfig,
  habitNudgePlan,
  zonedDay,
} from '@mossgoblin/schema';
import { AuthService } from '../auth.service';
import { ModulesService } from '../modules/modules.service';
import { type NoteRecord, NotesService } from '../notes/notes.service';
import { LocalStore } from '../platform/local-store';
import { NOW, TIME_ZONE } from '../platform/platform';
import { type ReminderRecord, RemindersService } from '../reminders/reminders.service';
import { isFeelingsJournal } from '../templates/templates.service';
import { HabitsService } from './habits.service';

/**
 * Where a dismissed offer is remembered, on this device: by uid, the
 * templates whose offer was dismissed. Nothing on the settings
 * document remembers a dismissal of this kind, so it is the device's
 * (step 7 of #324, 2026-11-22).
 */
export const JOURNAL_OFFER_DISMISSED_KEY = 'goblin.journalHabitsOfferDismissed';

/**
 * The habit a feelings journal's reminder becomes: its id derived from
 * the reminder's, so a second run of the move finds it, and a reminder
 * whose habit exists is known to have been moved. None for a reminder
 * id that would not make a habit's.
 */
export function journalHabitId(reminderId: string): string | undefined {
  const id = `journal-${reminderId}`;
  return HABIT_ID.test(id) ? id : undefined;
}

/**
 * A reminder a feelings journal made, as recognised (step 7 of #324,
 * 2026-11-22): daily, at a time, not a project's task, linked by its
 * `noteId` to a template that is a feelings journal (`isFeelingsJournal`:
 * a new entry each time, with a Moods line), with an id a habit's can
 * be derived from. Anything else is left a reminder.
 */
export function isJournalReminder(
  r: ReminderRecord,
  template: NoteRecord | undefined,
): template is NoteRecord {
  return (
    r.recurrence?.freq === 'daily' &&
    !!r.recurrence.time &&
    r.stage === undefined &&
    !!r.text.trim() &&
    journalHabitId(r.id) !== undefined &&
    !!template &&
    template.id === r.noteId &&
    isFeelingsJournal(template)
  );
}

/**
 * Whether a journal's reminder moves whole (review of #333,
 * 2026-11-22): nothing of it would be lost as a habit. Its words fit a
 * habit's name (HABIT_NAME_MAX), so they are never cut; it carries no
 * tags, which a habit has not; and it is not snoozed, a snooze being a
 * time he set that a habit cannot hold. Who made it is not kept: the
 * habit's `createdBy` is the gardener's, who makes it by accepting.
 * The journal Add a feelings journal makes has three such reminders.
 */
export function movesWhole(r: ReminderRecord): boolean {
  return r.text.trim().length <= HABIT_NAME_MAX && !r.tags?.length && r.status !== 'snoozed';
}

/**
 * What a reminder's line in the offer says of its habit's nudge, by the
 * quiet hours (`habitNudgePlan`, review of #333, 2026-11-22): nothing
 * when it goes at the reminder's time, "nudge at 06:00" when the quiet
 * hours hold it to their end, "nudge at 22:00" when its time is in them
 * before midnight and it goes as they begin (Eric, 2026-11-22: where it
 * said "no nudge at this time" until then).
 */
export function journalNudgeNote(time: string, config: HabitsConfig): string | undefined {
  const plan = habitNudgePlan({ schedule: 'daily', time, nudge: true }, config);
  if (plan.kind === 'held' || plan.kind === 'early') return `nudge at ${plan.time}`;
  return undefined;
}

/**
 * Whether a daily reminder was ticked done today: Done moves a repeat's
 * due time to its next occurrence, so a reminder that is open and due
 * only after today was done today. (One made today after its time also
 * reads so: its first occurrence is tomorrow.)
 */
export function reminderDoneToday(r: ReminderRecord, today: string, tz: string): boolean {
  return r.status === 'open' && r.dueAt !== undefined && zonedDay(r.dueAt, tz) > today;
}

/** One journal's offer: its template and the reminders it would move. */
export interface JournalOffer {
  template: NoteRecord;
  reminders: ReminderRecord[];
  /** "Your feelings journal has three reminders." */
  message: string;
  /** By reminder id, what its habit's nudge does, where not at its time. */
  nudges: Record<string, string>;
  /** Accepted, its habits being made. */
  moving: boolean;
  /** Accepted, and some habit could not be made: those listed did not move. */
  failed: boolean;
}

const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];

/**
 * A feelings journal's reminders made habits (step 7 of #324, Eric,
 * 2026-11-21: "move the reminders to the habits, keep the mood journal
 * and make this an open a note kind of habit"). Never a silent move:
 * while Habits is on, a journal whose reminders are still reminders is
 * offered on the Habits screen, once per journal until dismissed.
 *
 * A journal is offered only when every one of its reminders moves
 * whole (`movesWhole`, review of #333, 2026-11-22); otherwise it is not
 * offered at all, and its reminders stay reminders.
 *
 * Accepting makes, for each reminder, its habit at the derived id
 * (note kind, the template, the reminder's words, time and zone, nudge
 * on), only if none is there (`addIfAbsent`, a transaction, review of
 * #333): it needs the server, and offline nothing is written and the
 * offer says so. The rest is the pass below, for a move made here or
 * on another device: while Habits is on, a reminder whose derived
 * habit is heard is deleted, after, for one ticked done today, today
 * is marked done if it holds nothing on the server (`markDoneIfEmpty`,
 * a transaction too). So a reminder is never gone without its habit,
 * and a stale device never writes over a habit or a day. A mark that
 * could not reach the server is tried again on the next change heard,
 * a reload, or the connection coming back (`online`); the pass does
 * nothing for a gardener no longer signed in (review of #333).
 */
@Injectable({ providedIn: 'root' })
export class JournalHabitsService {
  private readonly auth = inject(AuthService);
  private readonly modules = inject(ModulesService);
  private readonly habits = inject(HabitsService);
  private readonly reminders = inject(RemindersService);
  private readonly notes = inject(NotesService);
  private readonly store = inject(LocalStore);
  private readonly now = inject(NOW);
  private readonly tz = inject(TIME_ZONE);
  /** Reminders whose delete has been sent, so it is sent once. */
  private readonly removed = new Set<string>();
  /** Reminders whose done mark is being written, so it is written once. */
  private readonly marking = new Set<string>();
  /** The gardener the pass last ran for: another's starts afresh. */
  private passUid?: string;
  /** Bumped when the connection returns, so a failed mark is tried again. */
  private readonly online = signal(0);
  /** Habits made here (or found there), before they are heard back. */
  private readonly made = signal<ReadonlySet<string>>(new Set());
  /** Templates whose offer was accepted, its habits being made. */
  private readonly moving = signal<ReadonlySet<string>>(new Set());
  /** Templates whose accept could not make every habit. */
  private readonly failed = signal<ReadonlySet<string>>(new Set());
  private readonly dismissed = signal<Record<string, string[]>>(
    this.store.get<Record<string, string[]>>(JOURNAL_OFFER_DISMISSED_KEY) ?? {},
  );

  /** The journals offered: Habits on and heard, reminders not yet moved. */
  readonly offers = computed<JournalOffer[]>(() => {
    const uid = this.auth.user()?.uid;
    if (!uid || !this.modules.habits() || !this.habits.loaded() || !this.notes.loaded()) return [];
    const have = new Set(this.habits.habits().map((h) => h.id));
    const made = this.made();
    const gone = new Set(this.dismissed()[uid] ?? []);
    const config = this.modules.habitsConfig();
    const byTemplate = new Map<string, { template: NoteRecord; reminders: ReminderRecord[] }>();
    // A journal with a reminder that would lose something: not offered.
    const held = new Set<string>();
    for (const r of this.reminders.reminders()) {
      const template = r.noteId ? this.notes.find(r.noteId) : undefined;
      if (!isJournalReminder(r, template)) continue;
      // Moved already, its delete waiting: not offered again.
      const habit = journalHabitId(r.id)!;
      if (have.has(habit) || made.has(habit)) continue;
      if (gone.has(template.id)) continue;
      if (!movesWhole(r)) held.add(template.id);
      const group = byTemplate.get(template.id) ?? { template, reminders: [] };
      group.reminders.push(r);
      byTemplate.set(template.id, group);
    }
    return [...byTemplate.values()].flatMap((g) => {
      if (held.has(g.template.id)) return [];
      const n = g.reminders.length;
      const count = COUNT[n] ?? String(n);
      const nudges: Record<string, string> = {};
      for (const r of g.reminders) {
        const note = journalNudgeNote(r.recurrence!.time!, config);
        if (note) nudges[r.id] = note;
      }
      return {
        ...g,
        nudges,
        moving: this.moving().has(g.template.id),
        failed: this.failed().has(g.template.id),
        reminders: [...g.reminders].sort((a, b) =>
          (a.recurrence?.time ?? '').localeCompare(b.recurrence?.time ?? ''),
        ),
        message: `Your feelings journal has ${count} reminder${n === 1 ? '' : 's'}. Make ${
          n === 1 ? 'it a habit' : 'them habits'
        }?`,
      };
    });
  });

  constructor() {
    // A move cut short (or made on another device and not yet finished
    // there): a reminder whose habit exists goes, its done mark first.
    effect(() => {
      // The pass is for this gardener (review of #333, 2026-11-22): a
      // mark is written only while he is still the one signed in and the
      // habits heard are his, and a reminder goes only if he still is.
      const uid = this.auth.user()?.uid;
      if (!uid || !this.modules.habits() || !this.habits.loaded()) return;
      const have = new Set(this.habits.habits().map((h) => h.id));
      const list = this.reminders.reminders();
      // Read so a log heard later runs this again, and a connection
      // come back tries a failed mark again (review of #333).
      this.habits.placed();
      this.online();
      untracked(() => {
        if (uid !== this.passUid) {
          this.passUid = uid;
          this.removed.clear();
          this.marking.clear();
        }
        const today = zonedDay(this.now(), this.tz);
        for (const r of list) {
          const id = journalHabitId(r.id);
          if (!id || !have.has(id) || this.removed.has(r.id) || this.marking.has(r.id)) continue;
          // Done today as a reminder: once the day's log is heard, a day
          // holding nothing is marked, only if the server holds nothing
          // for it either, then the reminder goes. Offline, both wait.
          if (reminderDoneToday(r, today, this.tz)) {
            if (!this.habits.dayHeard(id, today)) continue;
            if (this.habits.stateOn(id, today) === undefined) {
              this.marking.add(r.id);
              this.habits.markDoneIfEmpty(id, today, uid).then(
                () => {
                  this.marking.delete(r.id);
                  if (this.auth.user()?.uid !== uid) return;
                  this.drop(r.id);
                },
                (err) => {
                  this.marking.delete(r.id);
                  console.warn('journal habit day not marked yet', err);
                },
              );
              continue;
            }
          }
          this.drop(r.id);
        }
      });
    });
    const back = () => this.online.update((n) => n + 1);
    globalThis.addEventListener?.('online', back);
    inject(DestroyRef).onDestroy(() => globalThis.removeEventListener?.('online', back));
  }

  /**
   * Makes a journal's reminders its habits, each only if none is at its
   * id (`addIfAbsent`). The reminders are deleted by the pass above,
   * once the habits are heard. Offline, or refused, a habit not made
   * leaves its reminder offered, the offer saying so.
   */
  async accept(offer: JournalOffer): Promise<void> {
    const key = offer.template.id;
    if (!this.modules.habits() || this.moving().has(key)) return;
    const plus = (s: ReadonlySet<string>, id: string) => new Set([...s, id]);
    const minus = (s: ReadonlySet<string>, id: string) => new Set([...s].filter((x) => x !== id));
    this.moving.update((m) => plus(m, key));
    this.failed.update((f) => minus(f, key));
    const have = new Set([...this.habits.habits().map((h) => h.id), ...this.made()]);
    const results = await Promise.allSettled(
      offer.reminders.map(async (r) => {
        const id = journalHabitId(r.id);
        if (!id || !r.recurrence || have.has(id) || !movesWhole(r)) return;
        await this.habits.addIfAbsent({
          id,
          name: r.text,
          time: r.recurrence.time,
          tz: r.recurrence.tz,
          answer: 'note',
          template: key,
          nudge: true,
        });
        // Made, or there already: not offered again.
        this.made.update((m) => plus(m, id));
      }),
    );
    this.moving.update((m) => minus(m, key));
    if (results.some((x) => x.status === 'rejected')) this.failed.update((f) => plus(f, key));
  }

  /** Puts a journal's offer away for good, on this device. */
  dismiss(offer: JournalOffer): void {
    const uid = this.auth.user()?.uid;
    if (!uid) return;
    const all = { ...this.dismissed() };
    all[uid] = [...new Set([...(all[uid] ?? []), offer.template.id])];
    this.dismissed.set(all);
    this.store.set(JOURNAL_OFFER_DISMISSED_KEY, all);
  }

  /** Deletes a reminder, recorded only once the delete was sent. */
  private drop(id: string): void {
    if (this.removed.has(id)) return;
    if (this.reminders.remove(id)) this.removed.add(id);
  }
}
