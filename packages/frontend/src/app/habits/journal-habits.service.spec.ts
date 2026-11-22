import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { FEELINGS_TEMPLATE } from '@mossgoblin/schema';
import { AuthService } from '../auth.service';
import { ModulesService } from '../modules/modules.service';
import { NotesService } from '../notes/notes.service';
import type { NoteRecord } from '../notes/notes.service';
import { RemindersService } from '../reminders/reminders.service';
import {
  FakeHabitsApi,
  type FakeModules,
  FakeNotes,
  FakeRemindersApi,
  habitDoc,
  noteRecord,
  reminderDoc,
  remindersTestProviders,
} from '../testing/fakes';
import { HABITS_API, HabitsService } from './habits.service';
import {
  JOURNAL_OFFER_DISMISSED_KEY,
  JournalHabitsService,
  journalHabitId,
  reminderDoneToday,
} from './journal-habits.service';

const DAY = 24 * 60 * 60 * 1000;
// 2026-10-06 10:00 in New York, a Tuesday.
const NOW = Date.parse('2026-10-06T14:00:00Z');
const TZ = 'America/New_York';

const journal = (over: Partial<NoteRecord> = {}): NoteRecord => ({
  ...noteRecord('feel', FEELINGS_TEMPLATE.split('## Instructions')[0].trim()),
  kind: 'template',
  templateMode: 'entry',
  ...over,
});

const daily = (time: string) => ({ freq: 'daily', time, tz: TZ });

/** The journal's three reminders: breakfast done today, lunch and dinner still due. */
const journalReminders = (noteId = 'feel') => [
  reminderDoc('rb', {
    text: 'Feelings journal: breakfast',
    dueAt: Date.parse('2026-10-07T12:00:00Z'),
    recurrence: daily('08:00'),
    noteId,
  }),
  reminderDoc('rl', {
    text: 'Feelings journal: lunch',
    dueAt: Date.parse('2026-10-06T16:30:00Z'),
    recurrence: daily('12:30'),
    noteId,
  }),
  reminderDoc('rd', {
    text: 'Feelings journal: dinner',
    dueAt: Date.parse('2026-10-06T22:30:00Z'),
    recurrence: daily('18:30'),
    noteId,
  }),
];

function setup({ on = true, notes = [journal()] as NoteRecord[] } = {}) {
  const remindersApi = new FakeRemindersApi();
  const habitsApi = new FakeHabitsApi();
  const fakeNotes = new FakeNotes();
  fakeNotes.signIn(notes);
  const auth = signal<User | null | undefined>({ uid: 'u1' } as User);
  TestBed.configureTestingModule({
    providers: [
      ...remindersTestProviders(remindersApi, () => NOW),
      { provide: HABITS_API, useValue: habitsApi },
      { provide: AuthService, useValue: { user: auth } },
      { provide: NotesService, useValue: fakeNotes },
    ],
  });
  const modules = TestBed.inject(ModulesService) as unknown as FakeModules;
  if (on) modules.set('habits', true);
  TestBed.inject(RemindersService);
  const habits = TestBed.inject(HabitsService);
  const journals = TestBed.inject(JournalHabitsService);
  TestBed.tick();
  return {
    remindersApi,
    habitsApi,
    habits,
    journals,
    modules,
    reminders(docs: ReturnType<typeof reminderDoc>[]) {
      remindersApi.push(docs);
      TestBed.tick();
    },
    /** The habits' snapshot, then every log listened to as given, else empty. */
    habitDocs(
      docs: ReturnType<typeof habitDoc>[],
      logs: Record<string, Record<string, { state: 'done' | 'skipped' }>> = {},
      { heard = true } = {},
    ) {
      habitsApi.pushHabits(docs);
      TestBed.tick();
      if (!heard) return;
      for (const id of habitsApi.logs.keys()) habitsApi.pushLog(id, logs[id]);
      TestBed.tick();
    },
  };
}

/** What the move wrote, in order: habits, logs and deletes. */
function writes(r: ReturnType<typeof setup>) {
  const sets = r.habitsApi.set.mock.calls.map((c, i) => ({
    order: r.habitsApi.set.mock.invocationCallOrder[i],
    what: `set ${String(c[1]).replace('users/u1/', '')}`,
    data: c[2],
  }));
  const drops = r.remindersApi.drop.mock.calls.map((c, i) => ({
    order: r.remindersApi.drop.mock.invocationCallOrder[i],
    what: `drop ${String(c[1]).replace('users/u1/', '')}`,
    data: undefined,
  }));
  return [...sets, ...drops].sort((a, b) => a.order - b.order);
}

/** The derived habit of a journal reminder, as the move makes it. */
const movedHabit = (id: string, name: string, time: string) =>
  habitDoc(journalHabitId(id)!, {
    name,
    time,
    answer: 'note',
    template: 'feel',
    nudge: true,
    createdAt: NOW,
  });

describe('A feelings journal’s reminders made habits (#324 step 7)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('derives a habit id from a reminder’s, and none that a habit could not have', () => {
    expect(journalHabitId('AbC123')).toBe('journal-AbC123');
    expect(journalHabitId('with_underscore')).toBeUndefined();
    expect(journalHabitId('x'.repeat(60))).toBeUndefined();
  });

  it('reads a daily reminder done today from its next due time', () => {
    const r = { id: 'r', text: 't', status: 'open' as const, createdBy: 'user' as const };
    expect(
      reminderDoneToday({ ...r, dueAt: Date.parse('2026-10-07T12:00:00Z') }, '2026-10-06', TZ),
    ).toBe(true);
    expect(
      reminderDoneToday({ ...r, dueAt: Date.parse('2026-10-06T12:00:00Z') }, '2026-10-06', TZ),
    ).toBe(false);
    expect(
      reminderDoneToday(
        { ...r, status: 'snoozed', dueAt: Date.parse('2026-10-07T12:00:00Z') },
        '2026-10-06',
        TZ,
      ),
    ).toBe(false);
  });

  it('offers a feelings journal’s three daily reminders while Habits is on', () => {
    const r = setup();
    r.reminders(journalReminders());
    r.habitDocs([]);
    const [offer, ...more] = r.journals.offers();
    expect(more).toEqual([]);
    expect(offer.template.id).toBe('feel');
    expect(offer.message).toBe('Your feelings journal has three reminders. Make them habits?');
    expect(offer.reminders.map((x) => x.id)).toEqual(['rb', 'rl', 'rd']);
  });

  it('offers nothing while Habits is off, or before the habits are heard', () => {
    const off = setup({ on: false });
    off.reminders(journalReminders());
    expect(off.journals.offers()).toEqual([]);
    TestBed.resetTestingModule();
    const unheard = setup();
    unheard.reminders(journalReminders());
    expect(unheard.journals.offers()).toEqual([]);
  });

  it('is conservative: only daily, timed reminders to an entry template with a Moods line', () => {
    const r = setup({
      notes: [
        journal(),
        journal({ id: 'living', templateMode: 'living' }),
        journal({ id: 'gone', archived: true }),
        journal({ id: 'shut', locked: true }),
        { ...noteRecord('plain', 'Packing\n- socks'), kind: 'template' },
        { ...noteRecord('entry', 'Feelings\n\nMoods: [[calm]]'), fromTemplate: 'feel' },
      ],
    });
    r.reminders([
      reminderDoc('weekly', {
        text: 'Weekly',
        recurrence: { ...daily('08:00'), freq: 'weekly' },
        noteId: 'feel',
      }),
      reminderDoc('weekdays', {
        text: 'Weekdays',
        recurrence: { ...daily('08:00'), freq: 'weekdays' },
        noteId: 'feel',
      }),
      reminderDoc('once', { text: 'Once', dueAt: NOW, noteId: 'feel' }),
      reminderDoc('task', {
        text: 'Task',
        recurrence: daily('08:00'),
        noteId: 'feel',
        stage: 'doing',
      }),
      reminderDoc('bad_id', { text: 'Bad id', recurrence: daily('08:00'), noteId: 'feel' }),
      reminderDoc('loose', { text: 'Loose', recurrence: daily('08:00') }),
      ...['living', 'gone', 'shut', 'plain', 'entry', 'missing'].map((n) =>
        reminderDoc(`to-${n}`, { text: n, recurrence: daily('08:00'), noteId: n }),
      ),
    ]);
    r.habitDocs([]);
    expect(r.journals.offers()).toEqual([]);
  });

  it('accepting makes the habits, marks one done today done, and only then deletes the reminders', () => {
    const r = setup();
    r.reminders(journalReminders());
    r.habitDocs([]);
    r.habitsApi.set.mockClear();
    const offer = r.journals.offers()[0];
    r.journals.accept(offer);
    const done = writes(r);
    expect(done.map((w) => w.what)).toEqual([
      'set habits/journal-rb',
      'set habitLogs/journal-rb_2026-10',
      'set habits/journal-rl',
      'set habits/journal-rd',
      'drop reminders/rb',
      'drop reminders/rl',
      'drop reminders/rd',
    ]);
    expect(done[0].data).toMatchObject({
      name: 'Feelings journal: breakfast',
      schedule: 'daily',
      time: '08:00',
      tz: TZ,
      answer: 'note',
      template: 'feel',
      nudge: true,
      archived: false,
      createdBy: 'user',
    });
    expect(done[1].data).toMatchObject({
      habit: 'journal-rb',
      month: '2026-10',
      days: { '06': { state: 'done', answer: 'DELETE', noteId: 'DELETE' } },
    });
    // No Undo is offered for the move's own mark.
    expect(r.habits.undoable()).toBeNull();
    // Gone from the offer at once, made only once if pressed again.
    expect(r.journals.offers()).toEqual([]);
    r.journals.accept(offer);
    expect(r.habitsApi.set.mock.calls.length).toBe(4);
    expect(r.remindersApi.drop).toHaveBeenCalledTimes(3);
  });

  it('heard back, the habits finish the move once, with no second delete', () => {
    const r = setup();
    r.reminders(journalReminders());
    r.habitDocs([]);
    r.journals.accept(r.journals.offers()[0]);
    r.habitDocs(
      [
        movedHabit('rb', 'Feelings journal: breakfast', '08:00'),
        movedHabit('rl', 'Feelings journal: lunch', '12:30'),
        movedHabit('rd', 'Feelings journal: dinner', '18:30'),
      ],
      { 'journal-rb_2026-10': { '06': { state: 'done' } } },
    );
    expect(r.remindersApi.drop).toHaveBeenCalledTimes(3);
    expect(r.habits.toDo().map((h) => h.name)).toEqual([
      'Feelings journal: lunch',
      'Feelings journal: dinner',
    ]);
    expect(r.habits.settled().map((h) => h.name)).toEqual(['Feelings journal: breakfast']);
  });

  it('cut short after the habits: the next load deletes the reminders whose habits exist', () => {
    const r = setup();
    // The reminders and the habits both there, as a move cut short leaves them.
    r.reminders(journalReminders());
    r.habitDocs(
      [
        movedHabit('rl', 'Feelings journal: lunch', '12:30'),
        movedHabit('rd', 'Feelings journal: dinner', '18:30'),
      ],
      {},
    );
    expect(r.remindersApi.drop.mock.calls.map((c) => c[1])).toEqual([
      'users/u1/reminders/rl',
      'users/u1/reminders/rd',
    ]);
    // Breakfast had no habit yet: it is still offered, alone.
    expect(r.journals.offers()[0].reminders.map((x) => x.id)).toEqual(['rb']);
    expect(r.journals.offers()[0].message).toBe(
      'Your feelings journal has one reminder. Make it a habit?',
    );
    // Nothing logged for days not done.
    expect(r.habitsApi.set).not.toHaveBeenCalled();
  });

  it('cut short before the done mark: it is written once the day’s log is heard, then the delete', () => {
    const r = setup();
    r.reminders(journalReminders());
    r.habitDocs([movedHabit('rb', 'Feelings journal: breakfast', '08:00')], {}, { heard: false });
    // The day's log not heard yet: the delete waits for it.
    expect(r.remindersApi.drop).not.toHaveBeenCalled();
    for (const id of r.habitsApi.logs.keys()) r.habitsApi.pushLog(id, undefined);
    TestBed.tick();
    expect(writes(r).map((w) => w.what)).toEqual([
      'set habitLogs/journal-rb_2026-10',
      'drop reminders/rb',
    ]);
  });

  it('cut short after the done mark: the day is left as it is and the reminder deleted', () => {
    const r = setup();
    r.reminders(journalReminders());
    r.habitDocs([movedHabit('rb', 'Feelings journal: breakfast', '08:00')], {
      'journal-rb_2026-10': { '06': { state: 'skipped' } },
    });
    expect(writes(r).map((w) => w.what)).toEqual(['drop reminders/rb']);
  });

  it('does nothing with a moved reminder while Habits is off', () => {
    const r = setup({ on: false });
    r.reminders(journalReminders());
    expect(r.remindersApi.drop).not.toHaveBeenCalled();
  });

  it('puts the offer away for good on this device, for this gardener', () => {
    const r = setup();
    r.reminders(journalReminders());
    r.habitDocs([]);
    r.journals.dismiss(r.journals.offers()[0]);
    expect(r.journals.offers()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(JOURNAL_OFFER_DISMISSED_KEY)!)).toEqual({
      u1: ['feel'],
    });
    expect(r.remindersApi.drop).not.toHaveBeenCalled();
    expect(r.habitsApi.set).not.toHaveBeenCalled();
    // A reload remembers it.
    TestBed.resetTestingModule();
    const again = setup();
    again.reminders(journalReminders());
    again.habitDocs([]);
    expect(again.journals.offers()).toEqual([]);
  });

  it('a done mark is never written for a reminder done on another day', () => {
    const r = setup();
    r.reminders(
      journalReminders().map((d) =>
        d.id === 'rb'
          ? reminderDoc('rb', { ...(d.data as { text: string }), dueAt: NOW - DAY })
          : d,
      ),
    );
    r.habitDocs([]);
    r.journals.accept(r.journals.offers()[0]);
    expect(writes(r).some((w) => w.what.startsWith('set habitLogs'))).toBe(false);
  });
});
