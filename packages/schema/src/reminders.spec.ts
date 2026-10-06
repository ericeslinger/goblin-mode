import { describe, expect, it } from 'vitest';
import {
  effectiveDue,
  firstOccurrence,
  markDone,
  nextOccurrence,
  nextPushAfter,
  sectionOf,
  snoozeChoices,
  snoozeUntil,
} from './reminders';
import type { Recurrence } from './model';

const NY = 'America/New_York';
const HOUR = 60 * 60 * 1000;
const at = (iso: string) => Date.parse(iso);
const daily = (time: string, tz = NY): Recurrence => ({ freq: 'daily', time, tz });

describe('sectionOf', () => {
  // 2026-10-06 10:00 in New York.
  const now = at('2026-10-06T14:00:00Z');

  it('puts reminders with no time under Someday', () => {
    expect(sectionOf(undefined, now, NY)).toBe('someday');
  });

  it('splits by overdue, later today and after today, in the local day', () => {
    expect(sectionOf(now - 1, now, NY)).toBe('overdue');
    expect(sectionOf(at('2026-10-07T03:59:00Z'), now, NY)).toBe('today'); // 23:59 NY
    expect(sectionOf(at('2026-10-07T04:00:00Z'), now, NY)).toBe('soon'); // midnight NY
  });
});

describe('effectiveDue', () => {
  it('is the snooze while snoozed, else the due time', () => {
    expect(effectiveDue({ status: 'snoozed', dueAt: 1, snoozedUntil: 5 })).toBe(5);
    expect(effectiveDue({ status: 'open', dueAt: 1, snoozedUntil: 5 })).toBe(1);
    expect(effectiveDue({ status: 'open' })).toBeUndefined();
  });
});

describe('recurrence', () => {
  it('finds the next daily time in the reminder’s own time zone', () => {
    const from = at('2026-10-06T01:00:00Z'); // 21:00 NY on the 5th
    expect(nextOccurrence(daily('21:00'), from, from)).toBe(at('2026-10-07T01:00:00Z'));
  });

  it('skips weekends for weekdays', () => {
    const friday = at('2026-10-09T13:00:00Z'); // Fri 09:00 NY
    const rec: Recurrence = { freq: 'weekdays', time: '09:00', tz: NY };
    expect(nextOccurrence(rec, friday, friday)).toBe(at('2026-10-12T13:00:00Z'));
  });

  it('keeps the weekday for weekly', () => {
    const tuesday = at('2026-10-06T13:00:00Z');
    const rec: Recurrence = { freq: 'weekly', time: '09:00', tz: NY };
    expect(nextOccurrence(rec, tuesday, tuesday)).toBe(at('2026-10-13T13:00:00Z'));
  });

  it('catches up past missed days', () => {
    const old = at('2026-10-01T13:00:00Z');
    const now = at('2026-10-06T14:00:00Z');
    expect(nextOccurrence(daily('09:00'), old, now)).toBe(at('2026-10-07T13:00:00Z'));
  });

  it('keeps local time across a clock change', () => {
    // DST ends in New York on 2026-11-01.
    const before = at('2026-10-31T13:00:00Z'); // 09:00 EDT
    expect(nextOccurrence(daily('09:00'), before, before)).toBe(at('2026-11-01T14:00:00Z'));
  });

  it('lands just after a skipped hour, and on the first of a repeated one', () => {
    // 2026-03-08 02:30 does not exist in New York; 2026-11-01 01:30 happens twice.
    const sat = at('2026-03-07T12:00:00Z');
    expect(nextOccurrence(daily('02:30'), sat, sat)).toBe(at('2026-03-08T07:30:00Z'));
    const oct31 = at('2026-10-31T12:00:00Z');
    expect(nextOccurrence(daily('01:30'), oct31, oct31)).toBe(at('2026-11-01T05:30:00Z'));
  });

  it('starts today when the time is still ahead, else on the next allowed day', () => {
    const morning = at('2026-10-06T12:00:00Z'); // 08:00 NY, a Tuesday
    expect(firstOccurrence(daily('21:00'), morning)).toBe(at('2026-10-07T01:00:00Z'));
    expect(firstOccurrence(daily('07:00'), morning)).toBe(at('2026-10-07T11:00:00Z'));
    const saturday = at('2026-10-10T12:00:00Z');
    expect(firstOccurrence({ freq: 'weekdays', time: '21:00', tz: NY }, saturday)).toBe(
      at('2026-10-13T01:00:00Z'),
    );
  });
});

describe('markDone', () => {
  const now = at('2026-10-06T14:00:00Z');

  it('finishes a one-off reminder', () => {
    expect(markDone({ status: 'open', dueAt: now, nextFireAt: now }, now)).toEqual({
      status: 'done',
    });
  });

  it('moves a recurring reminder to its next time, even when done early', () => {
    const due = at('2026-10-07T01:00:00Z'); // tonight 21:00 NY
    const r = { status: 'open' as const, dueAt: due, recurrence: daily('21:00') };
    const next = at('2026-10-08T01:00:00Z');
    expect(markDone(r, now)).toEqual({ status: 'open', dueAt: next, nextFireAt: next });
  });

  it('clears a snooze on a recurring reminder', () => {
    const r = {
      status: 'snoozed' as const,
      dueAt: now - HOUR,
      snoozedUntil: now + HOUR,
      recurrence: daily('09:00'),
    };
    expect(markDone(r, now).status).toBe('open');
    expect(markDone(r, now).snoozedUntil).toBeUndefined();
  });
});

describe('snooze', () => {
  it('keeps the due time and fires at the snooze', () => {
    expect(snoozeUntil({ status: 'open', dueAt: 1 }, 9)).toEqual({
      status: 'snoozed',
      dueAt: 1,
      snoozedUntil: 9,
      nextFireAt: 9,
    });
  });

  it('offers an hour, tonight while it is early enough, and tomorrow morning', () => {
    const morning = at('2026-10-06T14:00:00Z');
    expect(snoozeChoices(morning, NY)).toEqual([
      { label: 'In an hour', at: morning + HOUR },
      { label: 'Tonight', at: at('2026-10-07T00:00:00Z') },
      { label: 'Tomorrow', at: at('2026-10-07T13:00:00Z') },
    ]);
    const late = at('2026-10-06T23:30:00Z'); // 19:30 NY
    expect(snoozeChoices(late, NY).map((c) => c.label)).toEqual(['In an hour', 'Tomorrow']);
  });
});

describe('nextPushAfter', () => {
  const now = at('2026-10-06T13:00:00Z'); // Tue 09:00 NY, just pushed

  it('stops after a one-off', () => {
    expect(nextPushAfter({ status: 'open', dueAt: now }, now)).toBeUndefined();
  });

  it('moves a repeat to its next occurrence, leaving dueAt alone', () => {
    const r = { status: 'open' as const, dueAt: now, recurrence: daily('09:00') };
    expect(nextPushAfter(r, now)).toBe(at('2026-10-07T13:00:00Z'));
  });

  it('counts a later time today after a snoozed push', () => {
    // Snoozed to 08:00, pushed then; today's 21:00 is still ahead.
    const r = {
      status: 'snoozed' as const,
      dueAt: at('2026-10-06T01:00:00Z'),
      snoozedUntil: at('2026-10-06T12:00:00Z'),
      recurrence: daily('21:00'),
    };
    expect(nextPushAfter(r, at('2026-10-06T12:00:00Z'))).toBe(at('2026-10-07T01:00:00Z'));
  });

  it('keeps the weekday for weekly, and catches up past missed weeks', () => {
    const tuesday = at('2026-09-22T13:00:00Z');
    const r = {
      status: 'open' as const,
      dueAt: tuesday,
      recurrence: { freq: 'weekly' as const, time: '09:00', tz: NY },
    };
    expect(nextPushAfter(r, now)).toBe(at('2026-10-13T13:00:00Z'));
  });
});
