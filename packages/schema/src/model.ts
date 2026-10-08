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
// | settings | client, direct | theme and mode, changed offline (#24, 2026-10-06) |
// | activity | function only | Claude's "What Claude changed" records |
// | proposals | function, plus the owner's accept or dismiss | nightly organize (#35) |
// | attachments | client, direct | a photo taken offline must be recorded offline (#43) |
// | notes/replaced | function only | texts writes replaced, for merges (2026-10-07) |
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

export const NoteKind = z.enum(['text', 'sketch', 'concept', 'template']);
export type NoteKind = z.infer<typeof NoteKind>;

export const ConceptType = z.enum(['person', 'project', 'mood', 'other']);
export type ConceptType = z.infer<typeof ConceptType>;

/**
 * What a project needs (#41, Eric 2026-10-08): build, Claude work
 * (code, tooling); content, Eric writes and Claude does not.
 */
export const ProjectKind = z.enum(['build', 'content']);
export type ProjectKind = z.infer<typeof ProjectKind>;

/** Where a project stands (#41, Eric's six). */
export const ProjectStatus = z.enum([
  'active',
  'nearly-done',
  'maintenance',
  'waiting',
  'done',
  'new',
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/**
 * How a template is used (#36): living, one note reused (the shopping
 * list); entry, a new note each time (a journal entry).
 */
export const TemplateMode = z.enum(['living', 'entry']);
export type TemplateMode = z.infer<typeof TemplateMode>;

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
  /**
   * Only on projects (#41): the project this one belongs to. Grouping,
   * never ordering or dependency: sub-projects run side by side.
   */
  parent: z.string().optional(),
  projectKind: ProjectKind.optional(),
  projectStatus: ProjectStatus.optional(),
  synonyms: z.array(z.string()).optional(),
  /** Ids of notes this note links to. */
  links: z.array(z.string()),
  tags: z.array(z.string()),
  /** Only on templates. Its schedule is a reminder naming it (`template`). */
  templateMode: TemplateMode.optional(),
  /** The id of the template this note was made from. */
  fromTemplate: z.string().optional(),
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
  /**
   * `textHash` of the text this body was written over, as the writer
   * last had it; '' when not known. A write over a newer text than that
   * is merged by noteHistory (#37).
   */
  baseHash: z.string().optional(),
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
  /**
   * A template's id: the reminder is that template's schedule, and
   * tapping it opens the template's note (#36).
   */
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

/** The five themes (UX Spec, Brand and style; Eric, 2026-10-06). */
export const ThemeId = z.enum(['herbarium', 'night', 'moss', 'bog', 'pixel']);
export type ThemeId = z.infer<typeof ThemeId>;
export const ThemeMode = z.enum(['system', 'light', 'dark']);
export type ThemeMode = z.infer<typeof ThemeMode>;

/** The gardener's settings, one doc (`settings/app`), shared by devices. */
export const Settings = z.object({
  theme: ThemeId,
  mode: ThemeMode,
  updatedAt: Timestamp,
});
export type Settings = z.infer<typeof Settings>;

/** A note or reminder a Claude run touched, named as it was then. */
export const Touched = z.object({
  id: z.string().min(1),
  title: z.string(),
});
export type Touched = z.infer<typeof Touched>;

/**
 * One Claude tool run that changed something, under `activity`
 * (function-only), shown in the app as What Claude changed (#34).
 */
export const Activity = z.object({
  at: Timestamp,
  /** The MCP tool, e.g. 'merge_notes'. */
  tool: z.string().min(1),
  /** One line saying what changed, for the gardener. */
  summary: z.string().min(1),
  notes: z.array(Touched),
  reminders: z.array(Touched),
});
export type Activity = z.infer<typeof Activity>;

export const ProposalKind = z.enum(['link', 'merge', 'refile']);
export type ProposalKind = z.infer<typeof ProposalKind>;

/**
 * open: waiting for the gardener. accepted and dismissed are the only
 * changes the app may make; applying, applied and failed are the
 * trigger's, as it runs the matching organize tool.
 */
export const ProposalStatus = z.enum([
  'open',
  'accepted',
  'dismissed',
  'applying',
  'applied',
  'failed',
]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

/**
 * A change the nightly organize run suggests (#35), under `proposals`.
 * Nothing changes until the gardener accepts it.
 */
export const Proposal = z.object({
  kind: ProposalKind,
  /** Why, in a sentence, for the gardener. */
  reason: z.string().min(1),
  /**
   * link: the note, then the notes it would link. merge: the notes, in
   * order. refile: the concept. Named as they were when proposed.
   */
  notes: z.array(Touched).min(1),
  /** merge: the merged note's title, if not the first note's. */
  title: z.string().optional(),
  /** refile: the concept's new type. */
  conceptType: ConceptType.optional(),
  /** refile: other names to add. */
  synonyms: z.array(z.string()).optional(),
  /** The same change proposed again has the same key, so it is not. */
  key: z.string().min(1),
  status: ProposalStatus,
  /** What applying it did, or why it could not. */
  outcome: z.string().optional(),
  createdAt: Timestamp,
  decidedAt: Timestamp.optional(),
  /** When the trigger began applying it; a stale claim is swept. */
  claimedAt: Timestamp.optional(),
});
export type Proposal = z.infer<typeof Proposal>;

/** What an attachment is (#43). */
export const AttachmentKind = z.enum(['image', 'pdf', 'link', 'drive']);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

/** The largest file the app stores (Eric, 2026-10-06); storage.rules too. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** File types the app stores; storage.rules checks the same list. */
export const ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;

/**
 * A file or link kept in the garden (#43), under `attachments`. Images
 * and PDFs live in Storage at `path` (users/{uid}/attachments/{id}/...);
 * links and Drive files are a URL. A note embeds one as
 * `![caption](attachment:<id>)`; one saved to read later need not be in
 * a note.
 */
export const Attachment = z.object({
  kind: AttachmentKind,
  /** The file's name, or the link's title. */
  name: z.string(),
  /** The note it belongs to, if any. */
  noteId: z.string().optional(),
  /** Images and PDFs: where the file is in Storage. */
  path: z.string().optional(),
  /** Links: the page. Drive files: where they open. */
  url: z.string().optional(),
  /** Drive files: the id Claude's Drive connector opens. */
  driveFileId: z.string().optional(),
  contentType: z.string().optional(),
  /** Bytes, for files. */
  size: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  /** A smaller image a function makes on upload (#44). */
  thumbPath: z.string().optional(),
  /** The reading queue: saved to read later (#48), and whether it was. */
  toRead: z.boolean(),
  read: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  createdBy: Author,
});
export type Attachment = z.infer<typeof Attachment>;

/** Firestore paths, all under the owner's uid. */
export const paths = {
  user: (uid: string) => `users/${uid}`,
  notes: (uid: string) => `users/${uid}/notes`,
  note: (uid: string, id: string) => `users/${uid}/notes/${id}`,
  history: (uid: string, id: string) => `users/${uid}/notes/${id}/history`,
  reminders: (uid: string) => `users/${uid}/reminders`,
  devices: (uid: string) => `users/${uid}/devices`,
  settings: (uid: string) => `users/${uid}/settings/app`,
  activity: (uid: string) => `users/${uid}/activity`,
  proposals: (uid: string) => `users/${uid}/proposals`,
  attachments: (uid: string) => `users/${uid}/attachments`,
  /** Server only: the texts recent writes replaced, for merges. */
  replaced: (uid: string, noteId: string) => `users/${uid}/notes/${noteId}/replaced`,
  /** Storage: an attachment's files, under its id. */
  attachmentFiles: (uid: string, id: string) => `users/${uid}/attachments/${id}`,
};
