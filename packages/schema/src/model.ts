// The contract between the app, the functions and (later) the generated
// Firestore rules. Each schema value and its inferred type share a name.
//
// Write path per collection (2026-10-05), all under users/{uid}:
//
// | Collection | Writes | Why |
// | --- | --- | --- |
// | notes | client, direct | capture must work offline; owner-only, nothing derived |
// | notes/history | function only | written by a trigger on note writes |
// | reminders | client, direct | swipe to done/snooze must work offline |
// | devices | client, direct | the device's own push token |
// | activity | function only | Claude's "What Claude changed" records |
// | oauth (top level) | function only | MCP auth state, never client-readable |
//
// Direct-write collections get shape validators generated from these
// schemas into firestore.rules; that generator lands with the first
// real client write (build order step 3). Claude's MCP writes go through
// functions and are validated against the same schemas there.
import { z } from 'zod';

/**
 * A Firestore Timestamp from either SDK. Client and admin Timestamps are
 * different classes, so the contract checks the shape, not the class.
 */
export const Timestamp = z.custom<{ seconds: number; nanoseconds: number }>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { seconds?: unknown }).seconds === 'number' &&
    typeof (v as { nanoseconds?: unknown }).nanoseconds === 'number',
  { message: 'expected a Firestore Timestamp' },
);
export type Timestamp = z.infer<typeof Timestamp>;

export const NoteKind = z.enum(['text', 'sketch', 'concept']);
export type NoteKind = z.infer<typeof NoteKind>;

export const ConceptType = z.enum(['person', 'project', 'other']);
export type ConceptType = z.infer<typeof ConceptType>;

export const TitleSource = z.enum(['words', 'llm', 'user']);
export type TitleSource = z.infer<typeof TitleSource>;

export const Author = z.enum(['user', 'claude']);
export type Author = z.infer<typeof Author>;

export const Note = z.object({
  kind: NoteKind,
  body: z.string(),
  title: z.string(),
  titleSource: TitleSource,
  /** Only on concepts. People and projects will extend this later. */
  conceptType: ConceptType.optional(),
  synonyms: z.array(z.string()).optional(),
  /** Ids of notes this note links to. */
  links: z.array(z.string()),
  tags: z.array(z.string()),
  /** Merged away by Claude; kept so a merge can be undone. */
  archived: z.boolean(),
  mergedInto: z.string().optional(),
  /**
   * When Eric last left the note after changing it (a fresh note after
   * five minutes, New, or opening another note). Asks noteTitle for a
   * Claude title.
   */
  settledAt: Timestamp.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  updatedBy: Author,
  /** The last device to write, so conflicts land in history. */
  deviceId: z.string(),
});
export type Note = z.infer<typeof Note>;

/** Why history kept a version (packages/schema/src/history.ts). */
export const KeepReason = z.enum(['device', 'author', 'interval', 'deleted']);
export type KeepReason = z.infer<typeof KeepReason>;

/**
 * A note as it stood before a later write replaced it, kept under
 * notes/{id}/history by the noteHistory trigger (function-only).
 */
export const NoteVersion = z.object({
  body: z.string(),
  title: z.string(),
  /** When this version was written, and by whom, from where. */
  updatedAt: Timestamp,
  updatedBy: Author,
  deviceId: z.string(),
  /** When history kept it. */
  savedAt: Timestamp,
  reason: KeepReason,
});
export type NoteVersion = z.infer<typeof NoteVersion>;

export const Recurrence = z.object({
  freq: z.enum(['daily', 'weekdays', 'weekly']),
  /** Local time of day, "HH:MM". */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** IANA time zone the time is in. */
  tz: z.string().min(1),
});
export type Recurrence = z.infer<typeof Recurrence>;

export const ReminderStatus = z.enum(['open', 'done', 'snoozed']);
export type ReminderStatus = z.infer<typeof ReminderStatus>;

export const Reminder = z.object({
  text: z.string().min(1),
  /** None means Someday. */
  dueAt: Timestamp.optional(),
  recurrence: Recurrence.optional(),
  status: ReminderStatus,
  snoozedUntil: Timestamp.optional(),
  /** Drives push; absent when there is nothing to send. */
  nextFireAt: Timestamp.optional(),
  noteId: z.string().optional(),
  /** e.g. 'feelings': tapping opens a new note from this template. */
  template: z.string().optional(),
  createdBy: Author,
});
export type Reminder = z.infer<typeof Reminder>;

/** A device that can receive web push: one per installed app. */
export const Device = z.object({
  /** The Firebase Cloud Messaging token for this device. */
  token: z.string().min(1),
  updatedAt: Timestamp,
});
export type Device = z.infer<typeof Device>;

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
