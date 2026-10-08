import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { User } from 'firebase/auth';
import { AuthService } from '../auth.service';
import { FakeRemindersApi, reminderDoc, remindersTestProviders } from '../testing/fakes';
import { RemindersService, TICK_MS, UNDO_MS } from './reminders.service';

const HOUR = 60 * 60 * 1000;
// 2026-10-06 10:00 in New York, a Tuesday.
const NOW = Date.parse('2026-10-06T14:00:00Z');

function setup() {
  const api = new FakeRemindersApi();
  const user = signal<User | null | undefined>({ uid: 'u1' } as User);
  let now = NOW;
  TestBed.configureTestingModule({
    providers: [
      ...remindersTestProviders(api, () => now),
      { provide: AuthService, useValue: { user } },
    ],
  });
  const reminders = TestBed.inject(RemindersService);
  TestBed.tick();
  return { reminders, api, user, setNow: (t: number) => (now = t) };
}

/** The data of the last write, with timestamps read back as millis. */
function lastWrite(api: FakeRemindersApi) {
  const [, path, data, merge] = api.set.mock.lastCall!;
  const plain = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k,
      (v as { toMillis?: () => number })?.toMillis?.() ?? v,
    ]),
  );
  return { path, data: plain, merge };
}

describe('RemindersService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('listens to open reminders and places them by section, soonest first', () => {
    const { reminders, api } = setup();
    expect(api.listen).toHaveBeenCalledWith(
      expect.anything(),
      'users/u1/reminders',
      expect.any(Function),
      expect.any(Function),
    );
    api.push([
      reminderDoc('someday', { text: 'learn the banjo' }),
      reminderDoc('soon', { text: 'card for nephew', dueAt: NOW + 48 * HOUR }),
      reminderDoc('today', { text: 'journal', dueAt: NOW + 2 * HOUR }),
      reminderDoc('late', { text: 'call the bank', dueAt: NOW - HOUR }),
      reminderDoc('snoozed', {
        text: 'water plants',
        status: 'snoozed',
        dueAt: NOW - 2 * HOUR,
        snoozedUntil: NOW + HOUR,
      }),
    ]);
    expect(reminders.placed().map((r) => [r.id, r.section])).toEqual([
      ['late', 'overdue'],
      ['snoozed', 'today'],
      ['today', 'today'],
      ['soon', 'soon'],
      ['someday', 'someday'],
    ]);
    expect(reminders.due().map((r) => r.id)).toEqual(['late', 'snoozed', 'today']);
  });

  it('moves items into Overdue as time passes', () => {
    const { reminders, api, setNow } = setup();
    api.push([reminderDoc('r1', { text: 'stretch', dueAt: NOW + 10_000 })]);
    expect(reminders.placed()[0].section).toBe('today');
    setNow(NOW + TICK_MS);
    vi.advanceTimersByTime(TICK_MS);
    expect(reminders.placed()[0].section).toBe('overdue');
  });

  it('adds a reminder with its time and push time', () => {
    const { reminders, api } = setup();
    reminders.add({ text: '  buy a card ', dueAt: NOW + HOUR });
    const { path, data, merge } = lastWrite(api);
    expect(path).toMatch(/^users\/u1\/reminders\/[A-Za-z0-9]{20}$/);
    expect(merge).toBe(false);
    expect(data).toEqual({
      text: 'buy a card',
      status: 'open',
      createdBy: 'user',
      dueAt: NOW + HOUR,
      nextFireAt: NOW + HOUR,
    });
  });

  it('adds at once when first made to add, before its listener starts (#40)', () => {
    const api = new FakeRemindersApi();
    TestBed.configureTestingModule({
      providers: [
        ...remindersTestProviders(api, () => NOW),
        { provide: AuthService, useValue: { user: signal({ uid: 'u1' } as User) } },
      ],
    });
    TestBed.inject(RemindersService).add({ text: 'Feelings', repeat: 'daily', at: '08:00' });
    expect(api.set.mock.lastCall![1]).toMatch(/^users\/u1\/reminders\//);
  });

  it('adds a Someday reminder with no times, and ignores empty text', () => {
    const { reminders, api } = setup();
    reminders.add({ text: '   ' });
    expect(api.set).not.toHaveBeenCalled();
    reminders.add({ text: 'learn the banjo' });
    expect(lastWrite(api).data).toEqual({
      text: 'learn the banjo',
      status: 'open',
      createdBy: 'user',
    });
  });

  it('adds a repeat at the chosen time, or 9 am when none is given', () => {
    const { reminders, api } = setup();
    const tonight = Date.parse('2026-10-07T01:00:00Z'); // 21:00 New York
    reminders.add({ text: 'journal', dueAt: tonight, repeat: 'daily' });
    expect(lastWrite(api).data['recurrence']).toEqual({
      freq: 'daily',
      time: '21:00',
      tz: 'America/New_York',
    });
    reminders.add({ text: 'stand-up', repeat: 'weekdays' });
    const tomorrow9 = Date.parse('2026-10-07T13:00:00Z');
    expect(lastWrite(api).data).toMatchObject({
      dueAt: tomorrow9,
      nextFireAt: tomorrow9,
      recurrence: { freq: 'weekdays', time: '09:00' },
    });
    // A time of day without a date, linked to a note (#40).
    reminders.add({ text: 'Feelings', repeat: 'daily', at: '18:30', noteId: 't1' });
    expect(lastWrite(api).data).toMatchObject({
      recurrence: { freq: 'daily', time: '18:30' },
      noteId: 't1',
    });
  });

  it('marks a one-off done, clearing its times, and undoes it', () => {
    const { reminders, api } = setup();
    api.push([
      reminderDoc('r1', { text: 'call the bank', dueAt: NOW - HOUR, nextFireAt: undefined }),
    ]);
    reminders.done(reminders.placed()[0]);
    expect(lastWrite(api)).toEqual({
      path: 'users/u1/reminders/r1',
      merge: true,
      data: { status: 'done', dueAt: 'DELETE', snoozedUntil: 'DELETE', nextFireAt: 'DELETE' },
    });
    expect(reminders.undoable()?.message).toBe('Done');
    reminders.undo();
    expect(lastWrite(api).data).toEqual({
      status: 'open',
      dueAt: NOW - HOUR,
      snoozedUntil: 'DELETE',
      nextFireAt: 'DELETE',
    });
    expect(reminders.undoable()).toBeNull();
  });

  it('moves a recurring reminder to its next time when done', () => {
    const { reminders, api } = setup();
    const due = Date.parse('2026-10-06T13:00:00Z');
    api.push([
      reminderDoc('r1', {
        text: 'stand-up',
        dueAt: due,
        recurrence: { freq: 'daily', time: '09:00', tz: 'America/New_York' },
      }),
    ]);
    reminders.done(reminders.placed()[0]);
    const next = due + 24 * HOUR;
    expect(lastWrite(api).data).toEqual({
      status: 'open',
      dueAt: next,
      snoozedUntil: 'DELETE',
      nextFireAt: next,
    });
    expect(reminders.undoable()?.message).toBe('Done until next time');
  });

  it('snoozes, and the undo offer expires', () => {
    const { reminders, api } = setup();
    api.push([reminderDoc('r1', { text: 'stretch', dueAt: NOW })]);
    reminders.snooze(reminders.placed()[0], NOW + HOUR);
    expect(lastWrite(api).data).toEqual({
      status: 'snoozed',
      dueAt: NOW,
      snoozedUntil: NOW + HOUR,
      nextFireAt: NOW + HOUR,
    });
    vi.advanceTimersByTime(UNDO_MS);
    expect(reminders.undoable()).toBeNull();
  });

  it('stops listening and forgets reminders on sign-out', () => {
    const { reminders, api, user } = setup();
    api.push([reminderDoc('r1', { text: 'stretch' })]);
    const stop = api.listen.mock.results[0].value;
    user.set(null);
    TestBed.tick();
    expect(stop).toHaveBeenCalled();
    expect(reminders.reminders()).toEqual([]);
    reminders.add({ text: 'too late' });
    expect(api.set).not.toHaveBeenCalled();
  });
});
