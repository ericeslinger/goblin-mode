import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HABIT_ID, zonedDay } from '@mossgoblin/schema';
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
}

const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];

/**
 * A feelings journal's reminders made habits (step 7 of #324, Eric,
 * 2026-11-21: "move the reminders to the habits, keep the mood journal
 * and make this an open a note kind of habit"). Never a silent move:
 * while Habits is on, a journal whose reminders are still reminders is
 * offered on the Habits screen, once per journal until dismissed.
 *
 * Accepting writes, in this order and never awaited, all through the
 * cache: for each reminder, its habit at the derived id (note kind,
 * the template, the reminder's words, time and zone, nudge on), then,
 * for one ticked done today, today's day done with no note; and only
 * then deletes the reminders. Firestore sends one device's writes in
 * the order made and keeps them so offline, so a move cut short leaves
 * habits with their reminders still there, never neither. The other
 * half (both) is finished on the next load, here: while Habits is on,
 * a reminder whose derived habit exists is deleted, once its done mark
 * for today has been checked for and written if it was missed.
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
  /** Habits made here, before they are heard back, so none is made twice. */
  private readonly made = signal<ReadonlySet<string>>(new Set());
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
    const byTemplate = new Map<string, { template: NoteRecord; reminders: ReminderRecord[] }>();
    for (const r of this.reminders.reminders()) {
      const template = r.noteId ? this.notes.find(r.noteId) : undefined;
      if (!isJournalReminder(r, template)) continue;
      // Moved already, its delete waiting: not offered again.
      const habit = journalHabitId(r.id)!;
      if (have.has(habit) || made.has(habit)) continue;
      if (gone.has(template.id)) continue;
      const group = byTemplate.get(template.id) ?? { template, reminders: [] };
      group.reminders.push(r);
      byTemplate.set(template.id, group);
    }
    return [...byTemplate.values()].map((g) => {
      const n = g.reminders.length;
      const count = COUNT[n] ?? String(n);
      return {
        ...g,
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
      if (!this.auth.user()?.uid || !this.modules.habits() || !this.habits.loaded()) return;
      const have = new Set(this.habits.habits().map((h) => h.id));
      const list = this.reminders.reminders();
      // Read so a log heard later runs this again.
      this.habits.placed();
      untracked(() => {
        for (const r of list) {
          const id = journalHabitId(r.id);
          if (!id || !have.has(id) || this.removed.has(r.id)) continue;
          if (!this.carryDone(r, id)) continue;
          this.removed.add(r.id);
          this.reminders.remove(r.id);
        }
      });
    });
  }

  /**
   * Makes a journal's reminders its habits, then deletes the reminders.
   * A reminder whose habit is there already (a run before) is not made
   * again; its delete is the load's, above, as it is here.
   */
  accept(offer: JournalOffer): void {
    if (!this.modules.habits()) return;
    const today = zonedDay(this.now(), this.tz);
    const have = new Set([...this.habits.habits().map((h) => h.id), ...this.made()]);
    const moved: string[] = [];
    for (const r of offer.reminders) {
      const id = journalHabitId(r.id);
      if (!id || !r.recurrence) continue;
      if (!have.has(id)) {
        const made = this.habits.add({
          id,
          name: r.text,
          time: r.recurrence.time,
          tz: r.recurrence.tz,
          answer: 'note',
          template: offer.template.id,
          nudge: true,
        });
        if (made !== id) continue;
        this.made.update((m) => new Set([...m, id]));
        // Its entry was made the old way, so the day holds no note.
        if (reminderDoneToday(r, today, this.tz)) this.habits.markDone(id, today);
      }
      moved.push(r.id);
    }
    for (const id of moved) {
      if (this.removed.has(id)) continue;
      this.removed.add(id);
      this.reminders.remove(id);
    }
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

  /**
   * On a later load: a reminder done today has its habit's today done,
   * if the move did not get that far. False while that day's log is not
   * heard yet, so the delete waits for it.
   */
  private carryDone(r: ReminderRecord, habit: string): boolean {
    const today = zonedDay(this.now(), this.tz);
    if (!reminderDoneToday(r, today, this.tz)) return true;
    if (!this.habits.dayHeard(habit, today)) return false;
    if (this.habits.stateOn(habit, today) === undefined) this.habits.markDone(habit, today);
    return true;
  }
}
