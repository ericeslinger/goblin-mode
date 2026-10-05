// The Firestore data model. See DESIGN.md, Data model.
// Timestamps are typed loosely so client and admin SDKs can share these.

export type Millis = number;

export type NoteKind = 'text' | 'sketch' | 'concept';
export type ConceptType = 'person' | 'project' | 'other';
export type TitleSource = 'words' | 'llm' | 'user';
export type Author = 'user' | 'claude';

export interface Note<T = unknown> {
  kind: NoteKind;
  body: string;
  title: string;
  titleSource: TitleSource;
  conceptType?: ConceptType;
  synonyms?: string[];
  links: string[];
  tags: string[];
  archived: boolean;
  mergedInto?: string;
  createdAt: T;
  updatedAt: T;
  updatedBy: Author;
  deviceId: string;
}

export type Recurrence = {
  freq: 'daily' | 'weekdays' | 'weekly';
  /** Local time of day, "HH:MM". */
  time: string;
  /** IANA time zone the time is in. */
  tz: string;
};

export type ReminderStatus = 'open' | 'done' | 'snoozed';

export interface Reminder<T = unknown> {
  text: string;
  dueAt?: T;
  recurrence?: Recurrence;
  status: ReminderStatus;
  snoozedUntil?: T;
  nextFireAt?: T;
  noteId?: string;
  template?: string;
  createdBy: Author;
}

/** Firestore paths, all under the owner's uid. */
export const paths = {
  user: (uid: string) => `users/${uid}`,
  notes: (uid: string) => `users/${uid}/notes`,
  note: (uid: string, id: string) => `users/${uid}/notes/${id}`,
  history: (uid: string, id: string) => `users/${uid}/notes/${id}/history`,
  reminders: (uid: string) => `users/${uid}/reminders`,
  devices: (uid: string) => `users/${uid}/devices`,
  activity: (uid: string) => `users/${uid}/activity`,
};
