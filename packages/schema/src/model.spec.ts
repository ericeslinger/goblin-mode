import { describe, expect, it } from 'vitest';
import { Note, Recurrence, Reminder, Timestamp, paths } from './model';

const ts = { seconds: 1_800_000_000, nanoseconds: 0 };

const note = {
  kind: 'text',
  body: 'Buy a card for nephew',
  title: 'Buy a card for nephew',
  titleSource: 'words',
  links: [],
  tags: [],
  archived: false,
  createdAt: ts,
  updatedAt: ts,
  updatedBy: 'user',
  deviceId: 'phone-1',
};

describe('Timestamp', () => {
  it('accepts anything shaped like a Firestore Timestamp', () => {
    expect(Timestamp.safeParse(ts).success).toBe(true);
    expect(Timestamp.safeParse(new Date()).success).toBe(false);
    expect(Timestamp.safeParse(1_800_000_000).success).toBe(false);
  });
});

describe('Note', () => {
  it('accepts a plain text note', () => {
    expect(Note.safeParse(note).success).toBe(true);
  });

  it('accepts a concept with a type and synonyms', () => {
    const concept = { ...note, kind: 'concept', conceptType: 'person', synonyms: ['vikgup'] };
    expect(Note.safeParse(concept).success).toBe(true);
  });

  it('rejects an unknown kind or author', () => {
    expect(Note.safeParse({ ...note, kind: 'folder' }).success).toBe(false);
    expect(Note.safeParse({ ...note, updatedBy: 'someone' }).success).toBe(false);
  });
});

describe('Recurrence', () => {
  it('accepts HH:MM and rejects anything else', () => {
    const r = { freq: 'daily', time: '21:00', tz: 'America/Los_Angeles' };
    expect(Recurrence.safeParse(r).success).toBe(true);
    expect(Recurrence.safeParse({ ...r, time: '9pm' }).success).toBe(false);
    expect(Recurrence.safeParse({ ...r, time: '24:00' }).success).toBe(false);
  });
});

describe('Reminder', () => {
  it('needs text, a status and an author', () => {
    expect(
      Reminder.safeParse({ text: 'journal', status: 'open', createdBy: 'claude' }).success,
    ).toBe(true);
    expect(Reminder.safeParse({ text: '', status: 'open', createdBy: 'user' }).success).toBe(false);
  });
});

describe('paths', () => {
  it('keeps everything under the owner', () => {
    expect(paths.note('u1', 'n1')).toBe('users/u1/notes/n1');
    expect(paths.history('u1', 'n1')).toBe('users/u1/notes/n1/history');
    expect(paths.reminders('u1')).toBe('users/u1/reminders');
  });
});
