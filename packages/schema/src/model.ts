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
// | settings | client, direct | theme and mode, changed offline (#24, 2026-10-06); the modules switched on (#126) |
// | activity | function only | "What assistants changed" records |
// | proposals | function, plus the owner's accept or dismiss | nightly organize (#35) |
// | attachments | client, direct | a photo taken offline must be recorded offline (#43) |
// | notes/replaced | function only | texts writes replaced, for merges (2026-10-07) |
// | settings/keys | function only | a gardener's masked provider keys (#144) |
// | oauth (top level) | function only | MCP auth state, never client-readable |
// | secrets (top level) | function only | a gardener's encrypted provider keys (#144), never client-readable |
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

/**
 * `context` (#113, 2026-10-17): the one note, at id `context`, whose text
 * Claude is given on every connection.
 */
export const NoteKind = z.enum([
  'text',
  'sketch',
  'concept',
  'template',
  'context',
  'recipe',
  'mealplan',
  'pantry',
]);
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

/** Who wrote it: Eric, or an assistant (`claude`, whichever one; see `agent`). */
export const Author = z.enum(['user', 'claude']);
export type Author = z.infer<typeof Author>;

/**
 * Which assistant wrote it, by the name its app registered with (#142):
 * "Claude", "Gemini CLI". Set on every write an assistant or the server
 * makes (updatedBy or createdBy `claude`, which means any assistant);
 * absent on writes before #142, which were all Claude's.
 */
export const AgentName = z.string().min(1).max(100);

/**
 * An assistant's name as stored: its app's registered name, kept to
 * letters, digits, spaces and plain punctuation, at most 60 characters.
 * It goes into note text (capture's `✳ <name>:`) and deviceIds, so no
 * newline, link, markup or emphasis gets through (review on #146).
 */
export function cleanAgentName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} .,'()-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

/** The assistant a document names, read leniently: Claude when none. */
export function agentOf(data: { agent?: unknown }): string {
  return typeof data.agent === 'string' && data.agent.trim() ? data.agent : 'Claude';
}

/** How long a Send to an assistant ask, and its outcome, may be (#143). */
export const SEND_ASK_MAX = 500;
export const SEND_OUTCOME_MAX = 300;

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
  /**
   * Only on projects (Eric, 2026-10-17): the stages the project's items
   * (its sub-projects and tasks) move through, in order, and the tags
   * they may carry. Data, so a new stage needs no new app.
   */
  stages: z.array(z.string()).optional(),
  itemTags: z.array(z.string()).optional(),
  /** Only on a sub-project: where it stands among its parent's `stages`. */
  stage: z.string().optional(),
  synonyms: z.array(z.string()).optional(),
  /** Ids of notes this note links to. */
  links: z.array(z.string()),
  tags: z.array(z.string()),
  /** Only on templates. Its schedule is a reminder naming it (`template`). */
  templateMode: TemplateMode.optional(),
  /**
   * Only on templates (#111, 2026-10-17): how Claude fills in or tidies
   * notes made from it, kept out of the text Eric writes in. A template
   * from before still holds an "Instructions for Claude" section in its
   * body until the app moves it here.
   */
  instructions: z.string().optional(),
  /**
   * Only on recipes (#127, 2026-10-18): where it came from (a page, an
   * attached photo or PDF, the original text) and how many it serves.
   */
  source: z
    .object({
      url: z.string().optional(),
      attachmentId: z.string().optional(),
      text: z.string().optional(),
    })
    .optional(),
  servings: z.number().optional(),
  /**
   * Only on a recipe imported from its source url (#128, 2026-10-18):
   * the app asks with 'requested'; a function reads the page and says
   * 'done', or 'failed' with why in `importError`.
   */
  importState: z.enum(['requested', 'working', 'done', 'failed']).optional(),
  importError: z.string().optional(),
  /**
   * Only on meal plans (#129, 2026-10-18): the first day of the week the
   * plan covers, YYYY-MM-DD; its id is meals-<that day>.
   */
  periodStart: z.string().optional(),
  /**
   * Sent to an assistant (#143): Eric's Send to an assistant sets
   * `queued`, with what he asks in `sendAsk` and when in `sentAt`. His
   * own assistant, checking on a schedule (list_queue), does it and
   * marks it `done` with one line in `sendOutcome` (finish_queued).
   */
  sendState: z.enum(['queued', 'done']).optional(),
  sendAsk: z.string().max(SEND_ASK_MAX).optional(),
  sentAt: Timestamp.optional(),
  sendOutcome: z.string().max(SEND_OUTCOME_MAX).optional(),
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
  agent: AgentName.optional(),
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
  agent: AgentName.optional(),
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
  /**
   * A project's task (one with `noteId` naming a project): where it
   * stands among the project's `stages`, and which of its `itemTags`
   * it carries (Eric, 2026-10-17).
   */
  stage: z.string().optional(),
  tags: z.array(z.string()).optional(),
  createdBy: Author,
  agent: AgentName.optional(),
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

/**
 * One module's switch and its configuration (#126, Eric 2026-10-18).
 * The config's shape is the module's own; the rules check it is a map.
 */
export const ModuleSetting = z.object({
  enabled: z.boolean(),
  config: z.object({}).passthrough().optional(),
});
export type ModuleSetting = z.infer<typeof ModuleSetting>;

/**
 * The modules switched on, one doc (`settings/modules`), shared by
 * devices. Its own doc, not a field of `settings/app`: the theme writes
 * that doc whole. One field per module the app knows (MODULES).
 */
export const ModuleSettings = z.object({
  projects: ModuleSetting.optional(),
  kitchen: ModuleSetting.optional(),
  updatedAt: Timestamp,
});
export type ModuleSettings = z.infer<typeof ModuleSettings>;

/** A note or reminder a Claude run touched, named as it was then. */
export const Touched = z.object({
  id: z.string().min(1),
  title: z.string(),
});
export type Touched = z.infer<typeof Touched>;

/**
 * One Claude tool run that changed something, under `activity`
 * (function-only), shown in the app as What assistants changed (#34).
 */
export const Activity = z.object({
  at: Timestamp,
  /** The MCP tool, e.g. 'merge_notes'. */
  tool: z.string().min(1),
  /** One line saying what changed, for the gardener. */
  summary: z.string().min(1),
  notes: z.array(Touched),
  reminders: z.array(Touched),
  /** Which assistant made the change (#142); absent before, when it was Claude. */
  agent: AgentName.optional(),
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
  /**
   * PDFs and imported links: their text, extracted by a function into a
   * file beside the attachment (#45, server only), and a PDF's pages.
   */
  textPath: z.string().optional(),
  pages: z.number().optional(),
  /** Links: why the page could not be imported, if it could not (#48). */
  importError: z.string().optional(),
  /**
   * Transcription (#47): the app asks with 'requested'; a function
   * claims it ('working'), then writes a note of Claude's transcription
   * ('done', `transcriptNoteId`) or says why not ('failed').
   */
  transcribe: z.enum(['requested', 'working', 'done', 'failed']).optional(),
  transcriptNoteId: z.string().optional(),
  /** When the function claimed it: one stuck 'working' long can be asked again. */
  transcribeStartedAt: Timestamp.optional(),
  transcribeError: z.string().optional(),
  /** The reading queue: saved to read later (#48), and whether it was. */
  toRead: z.boolean(),
  read: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  createdBy: Author,
  agent: AgentName.optional(),
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
  modules: (uid: string) => `users/${uid}/settings/modules`,
  activity: (uid: string) => `users/${uid}/activity`,
  proposals: (uid: string) => `users/${uid}/proposals`,
  attachments: (uid: string) => `users/${uid}/attachments`,
  /** The gardener's masked provider keys (#144), read by the app. */
  keys: (uid: string) => `users/${uid}/settings/keys`,
  /** Server only: the gardener's encrypted provider keys (#144). */
  secrets: (uid: string) => `secrets/${uid}`,
  /** Server only: a day's metered calls, e.g. transcriptions (#47). */
  usage: (uid: string, day: string) => `users/${uid}/usage/${day}`,
  /** Server only: the texts recent writes replaced, for merges. */
  replaced: (uid: string, noteId: string) => `users/${uid}/notes/${noteId}/replaced`,
  /** Storage: an attachment's files, under its id. */
  attachmentFiles: (uid: string, id: string) => `users/${uid}/attachments/${id}`,
};
