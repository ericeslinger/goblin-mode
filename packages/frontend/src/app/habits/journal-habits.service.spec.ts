import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { FEELINGS_TEMPLATE, FEELINGS_TIMES, HABIT_NAME_MAX } from '@mossgoblin/schema';
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
  journalNudgeNote,
  reminderDoneToday,
} from './journal-habits.service';
import { JournalOfferLine } from './journal-offer';
import { habitsConfig } from '@mossgoblin/schema';

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
    remindersService: TestBed.inject(RemindersService),
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

/** Lets the writes' promises settle, then the effects run again. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  TestBed.tick();
}

type Calls = { mock: { calls: unknown[][]; invocationCallOrder: number[] } };

/**
 * What the move wrote, in order: plain sets, habits made only if absent
 * (`create`), days marked only if empty (`mark`), and deletes.
 */
function writes(r: ReturnType<typeof setup>) {
  const of = (kind: string, fn: Calls, data: number) =>
    fn.mock.calls.map((c, i) => ({
      order: fn.mock.invocationCallOrder[i],
      what: `${kind} ${String(c[1]).replace('users/u1/', '')}`,
      data: c[data] as Record<string, unknown> | undefined,
    }));
  return [
    ...of('set', r.habitsApi.set, 2),
    ...of('create', r.habitsApi.createIfAbsent, 2),
    ...of('mark', r.habitsApi.setDayIfEmpty, 3),
    ...of('drop', r.remindersApi.drop, 2),
  ].sort((a, b) => a.order - b.order);
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

/** The three habits, as heard back after the move. */
const movedHabits = () => [
  movedHabit('rb', 'Feelings journal: breakfast', '08:00'),
  movedHabit('rl', 'Feelings journal: lunch', '12:30'),
  movedHabit('rd', 'Feelings journal: dinner', '18:30'),
];

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

  it('accepting makes each habit only if absent; heard back, marks one done today and deletes', async () => {
    const r = setup();
    r.reminders(journalReminders());
    r.habitDocs([]);
    const offer = r.journals.offers()[0];
    void r.journals.accept(offer);
    // Being made: the offer says so and takes no second press.
    expect(r.journals.offers()[0].moving).toBe(true);
    await settle();
    expect(writes(r).map((w) => w.what)).toEqual([
      'create habits/journal-rb',
      'create habits/journal-rl',
      'create habits/journal-rd',
    ]);
    expect(writes(r)[0].data).toMatchObject({
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
    // Gone from the offer at once, made only once if pressed again.
    expect(r.journals.offers()).toEqual([]);
    await r.journals.accept(offer);
    expect(r.habitsApi.createIfAbsent).toHaveBeenCalledTimes(3);
    // No plain write, and no delete before the habits are heard.
    expect(r.habitsApi.set).not.toHaveBeenCalled();
    expect(r.remindersApi.drop).not.toHaveBeenCalled();
    r.habitDocs(movedHabits(), {});
    await settle();
    const done = writes(r).slice(3);
    expect(done.map((w) => w.what)).toEqual([
      'drop reminders/rl',
      'drop reminders/rd',
      'mark habitLogs/journal-rb_2026-10',
      'drop reminders/rb',
    ]);
    expect(r.habitsApi.setDayIfEmpty.mock.calls[0][2]).toBe('06');
    expect(done[2].data).toMatchObject({
      habit: 'journal-rb',
      month: '2026-10',
      days: { '06': { state: 'done' } },
    });
    // No Undo is offered for the move's own mark.
    expect(r.habits.undoable()).toBeNull();
  });

  it('heard back, the habits finish the move once, with no second delete', async () => {
    const r = setup();
    r.reminders(journalReminders());
    r.habitDocs([]);
    await r.journals.accept(r.journals.offers()[0]);
    r.habitDocs(movedHabits(), { 'journal-rb_2026-10': { '06': { state: 'done' } } });
    await settle();
    r.habitDocs(movedHabits(), { 'journal-rb_2026-10': { '06': { state: 'done' } } });
    await settle();
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

  it('cut short before the done mark: once the day is heard, it is marked only if the server holds nothing, then the delete', async () => {
    const r = setup();
    r.reminders(journalReminders());
    r.habitDocs([movedHabit('rb', 'Feelings journal: breakfast', '08:00')], {}, { heard: false });
    await settle();
    // The day's log not heard yet: nothing is marked or deleted.
    expect(writes(r)).toEqual([]);
    for (const id of r.habitsApi.logs.keys()) r.habitsApi.pushLog(id, undefined);
    await settle();
    expect(writes(r).map((w) => w.what)).toEqual([
      'mark habitLogs/journal-rb_2026-10',
      'drop reminders/rb',
    ]);
  });

  it('cut short after the done mark: the day is left as it is and the reminder deleted', async () => {
    const r = setup();
    r.reminders(journalReminders());
    r.habitDocs([movedHabit('rb', 'Feelings journal: breakfast', '08:00')], {
      'journal-rb_2026-10': { '06': { state: 'skipped' } },
    });
    await settle();
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

  it('a done mark is never written for a reminder done on another day', async () => {
    const r = setup();
    r.reminders(
      journalReminders().map((d) =>
        d.id === 'rb'
          ? reminderDoc('rb', { ...(d.data as { text: string }), dueAt: NOW - DAY })
          : d,
      ),
    );
    r.habitDocs([]);
    await r.journals.accept(r.journals.offers()[0]);
    r.habitDocs(movedHabits(), {});
    await settle();
    expect(writes(r).some((w) => w.what.startsWith('mark') || w.what.startsWith('set'))).toBe(
      false,
    );
    expect(r.remindersApi.drop).toHaveBeenCalledTimes(3);
  });

  describe('the review of #333 (2026-11-22)', () => {
    it('never cuts his words: a journal with a reminder past a habit’s name is not offered', () => {
      const r = setup();
      const [rb, rl, rd] = journalReminders();
      const long = 'x'.repeat(HABIT_NAME_MAX + 1);
      r.reminders([rb, rl, reminderDoc('rd', { ...(rd.data as { text: string }), text: long })]);
      r.habitDocs([]);
      expect(r.journals.offers()).toEqual([]);
      // One that fits exactly is offered, and made with every word.
      r.reminders([
        rb,
        rl,
        reminderDoc('rd', { ...(rd.data as { text: string }), text: 'y'.repeat(HABIT_NAME_MAX) }),
      ]);
      expect(r.journals.offers()[0].reminders.map((x) => x.id)).toEqual(['rb', 'rl', 'rd']);
    });

    it('never cuts his words in the habit made either', async () => {
      const r = setup();
      r.reminders([]);
      r.habitDocs([]);
      await expect(
        r.habits.addIfAbsent({ id: 'journal-x', name: 'z'.repeat(HABIT_NAME_MAX + 1) }),
      ).rejects.toThrow();
      expect(r.habitsApi.createIfAbsent).not.toHaveBeenCalled();
    });

    it('drops nothing he set: a tagged or snoozed reminder keeps its journal from the offer', () => {
      const r = setup();
      const [rb, rl, rd] = journalReminders();
      const data = (d: typeof rb) => d.data as { text: string };
      r.habitDocs([]);
      r.reminders([rb, rl, reminderDoc('rd', { ...data(rd), tags: ['food'] })]);
      expect(r.journals.offers()).toEqual([]);
      r.reminders([
        rb,
        rl,
        reminderDoc('rd', { ...data(rd), status: 'snoozed', snoozedUntil: NOW + DAY }),
      ]);
      expect(r.journals.offers()).toEqual([]);
      // Made by the assistant: offered, the habit made by him in accepting.
      r.reminders([rb, rl, reminderDoc('rd', { ...data(rd), createdBy: 'claude', agent: 'x' })]);
      expect(r.journals.offers()[0].reminders.map((x) => x.id)).toEqual(['rb', 'rl', 'rd']);
    });

    it('the journal Add a feelings journal makes still qualifies, its reminders as written', async () => {
      const r = setup();
      for (const { time, text } of FEELINGS_TIMES) {
        r.remindersService.add({ text, repeat: 'daily', at: time, noteId: 'feel' });
      }
      const stamp = (v: unknown) => (v as { toMillis(): number }).toMillis();
      r.reminders(
        r.remindersApi.set.mock.calls.map((c) => {
          const { dueAt, nextFireAt, ...rest } = c[2] as Record<string, unknown>;
          return {
            id: String(c[1]).split('/').pop()!,
            data: {
              ...rest,
              dueAt: { toMillis: () => stamp(dueAt) },
              nextFireAt: { toMillis: () => stamp(nextFireAt) },
            },
          };
        }),
      );
      r.habitDocs([]);
      const [offer] = r.journals.offers();
      expect(offer.reminders.map((x) => x.text)).toEqual(FEELINGS_TIMES.map((t) => t.text));
      expect(offer.nudges).toEqual({});
    });

    it('never writes over a habit the server has: an accept made stale makes nothing', async () => {
      const r = setup();
      r.reminders(journalReminders());
      r.habitDocs([]);
      // Accepted on another device and renamed there; this one has not heard.
      r.habitsApi.createIfAbsent.mockResolvedValue(false);
      await r.journals.accept(r.journals.offers()[0]);
      expect(r.habitsApi.createIfAbsent).toHaveBeenCalledTimes(3);
      expect(r.habitsApi.set).not.toHaveBeenCalled();
      expect(r.journals.offers()).toEqual([]);
      expect(r.remindersApi.drop).not.toHaveBeenCalled();
    });

    it('never rewrites a day the server holds: the mark is not made, the reminder goes', async () => {
      const r = setup();
      r.reminders(journalReminders());
      // Logged on another device with its entry; this device's log not heard.
      r.habitsApi.setDayIfEmpty.mockResolvedValue(false);
      r.habitDocs([movedHabit('rb', 'Feelings journal: breakfast', '08:00')], {});
      await settle();
      expect(r.habitsApi.set).not.toHaveBeenCalled();
      expect(writes(r).map((w) => w.what)).toEqual([
        'mark habitLogs/journal-rb_2026-10',
        'drop reminders/rb',
      ]);
    });

    it('offline, an accept writes nothing, deletes nothing and says so', async () => {
      const r = setup();
      r.reminders(journalReminders());
      r.habitDocs([]);
      r.habitsApi.createIfAbsent.mockRejectedValue(new Error('offline'));
      await r.journals.accept(r.journals.offers()[0]);
      const [offer] = r.journals.offers();
      expect(offer.reminders).toHaveLength(3);
      expect(offer.failed).toBe(true);
      expect(offer.moving).toBe(false);
      expect(r.habitsApi.set).not.toHaveBeenCalled();
      expect(r.remindersApi.drop).not.toHaveBeenCalled();
      // A mark that cannot reach the server keeps the reminder too.
      r.habitsApi.setDayIfEmpty.mockRejectedValue(new Error('offline'));
      r.habitDocs([movedHabit('rb', 'Feelings journal: breakfast', '08:00')], {});
      await settle();
      expect(r.habitsApi.setDayIfEmpty).toHaveBeenCalledTimes(1);
      expect(r.remindersApi.drop).not.toHaveBeenCalled();
    });

    it('a delete that could not be sent is sent again on the next pass', () => {
      const r = setup();
      const remove = vi.spyOn(r.remindersService, 'remove').mockReturnValueOnce(false);
      const [, rl] = journalReminders();
      r.reminders([rl]);
      // The habit heard (the delete not sent), then its log (sent then).
      r.habitDocs([movedHabit('rl', 'Feelings journal: lunch', '12:30')]);
      expect(remove).toHaveBeenCalledTimes(2);
      expect(r.remindersApi.drop).toHaveBeenCalledTimes(1);
      // Sent once: never again.
      r.reminders([rl]);
      expect(remove).toHaveBeenCalledTimes(2);
    });

    it('says on a reminder’s line where the quiet hours hold its nudge or silence it', () => {
      const config = habitsConfig({});
      expect(journalNudgeNote('08:00', config)).toBeUndefined();
      expect(journalNudgeNote('05:00', config)).toBe('nudge at 06:00');
      expect(journalNudgeNote('23:00', config)).toBe('no nudge at this time');
      const r = setup();
      const [rb, rl, rd] = journalReminders();
      const data = (d: typeof rb) => d.data as { text: string };
      r.reminders([
        reminderDoc('rb', { ...data(rb), recurrence: daily('05:00') }),
        rl,
        reminderDoc('rd', { ...data(rd), recurrence: daily('23:00') }),
      ]);
      r.habitDocs([]);
      expect(r.journals.offers()[0].nudges).toEqual({
        rb: 'nudge at 06:00',
        rd: 'no nudge at this time',
      });
    });

    it('the offer says what changes, each line its time and nudge', async () => {
      const r = setup();
      const [rb, rl, rd] = journalReminders();
      r.reminders([
        reminderDoc('rb', { ...(rb.data as { text: string }), recurrence: daily('05:00') }),
        rl,
        rd,
      ]);
      r.habitDocs([]);
      const fixture = TestBed.createComponent(JournalOfferLine);
      fixture.detectChanges();
      const text = (fixture.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
      expect(text).toContain('Your feelings journal has three reminders. Make them habits?');
      expect(text).toContain(
        '05:00 Feelings journal: breakfast (nudge at 06:00) · 12:30 Feelings journal: lunch · ' +
          '18:30 Feelings journal: dinner',
      );
      expect(text).toContain(
        'Each becomes a daily habit at the same time, nudging you once then if it is not ' +
          'logged yet. The nudge opens Right Now, where ticking the habit opens a new entry; ' +
          "a reminder's push opened the entry itself.",
      );
      expect(text).not.toContain('Not moved yet');
      r.habitsApi.createIfAbsent.mockRejectedValue(new Error('offline'));
      await r.journals.accept(r.journals.offers()[0]);
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).textContent).toContain(
        'Not moved yet: making habits needs a connection.',
      );
    });
  });
});
