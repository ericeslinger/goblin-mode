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
// | runs | function only | the garden's own agent runs (#144 step 3) |
// | proposals | function, plus the owner's accept or dismiss | nightly organize (#35) |
// | attachments | client, direct | a photo taken offline must be recorded offline (#43) |
// | notes/replaced | function only | texts writes replaced, for merges (2026-10-07) |
// | settings/keys | function only | a gardener's masked provider keys (#144) |
// | feeds | client, direct | the feeds followed (#159): an OPML import works offline; functions add fetch state |
// | feedItems | function, plus the owner's read and saved marks | the Reader's articles (#159), written by the fetcher |
// | settings/reader | client, direct | the Reader's folder order and switches (#159) |
// | settings/assistant | client, direct | the assistant's switches, e.g. garden on arrival (#214) |
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
  /** An article filed from the Reader (#163, 2026-11-07): web text, labelled so for assistants. */
  'clipping',
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
   * Only on recipes (#127, 2026-10-18) and clippings (#163): where it
   * came from (a page, an attached photo or PDF, the original text, the
   * Reader article it was filed from) and, for a recipe, how many it
   * serves.
   */
  source: z
    .object({
      url: z.string().optional(),
      attachmentId: z.string().optional(),
      text: z.string().optional(),
      feedItemId: z.string().optional(),
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
  /** The run doing it now (#144 step 3), under `runs`, if Eric asked for one. */
  sendRun: z.string().optional(),
  /**
   * Sent by the server when the note first settled, not by Eric (#214,
   * Garden on arrival): the back says so. Cleared with the other send
   * fields when he takes it back or sends it himself.
   */
  sentOnArrival: z.boolean().optional(),
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

/**
 * The screen a cold open of `/` lands on (#219, 2026-11-09): Home, a
 * new note (as before, the default), Right Now, Kitchen or the Reader.
 */
export const StartOn = z.enum(['home', 'note', 'right-now', 'kitchen', 'reader']);
export type StartOn = z.infer<typeof StartOn>;

/** The gardener's settings, one doc (`settings/app`), shared by devices. */
export const Settings = z.object({
  theme: ThemeId,
  mode: ThemeMode,
  /** Absent until chosen, and on every doc from before #219: a new note. */
  startOn: StartOn.optional(),
  /**
   * Home's tiles in the gardener's order (#222, 2026-11-09), by id.
   * Absent until arranged; a tile missing from it joins at the end.
   */
  homeTiles: z.array(z.string().min(1).max(40)).max(40).optional(),
  /** The tiles taken off Home in Arrange Home, by id (#222). */
  homeHidden: z.array(z.string().min(1).max(40)).max(40).optional(),
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
  reader: ModuleSetting.optional(),
  updatedAt: Timestamp,
});
export type ModuleSettings = z.infer<typeof ModuleSettings>;

/** A note or reminder a Claude run touched, named as it was then. */
export const Touched = z.object({
  id: z.string().min(1),
  title: z.string(),
  /**
   * The run made this note, so putting it back archives it (#211,
   * 2026-11-09). Absent on a note it only changed, and on every record
   * from before.
   */
  made: z.boolean().optional(),
  /**
   * The value each field the run changed had before it, null where the
   * field was absent, so putting the run back restores them (#206,
   * 2026-11-09). Only filing (`refile`) and `finish_queued` keep it,
   * since History keeps text, not these fields, and a put back of one
   * keeps the values it replaced. Never the text itself, which History
   * keeps: where the run rewrote it (filing as a project adds the
   * project sections), `body` holds the `textHash` of the text before,
   * the key History and the replaced texts are kept by.
   */
  before: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])).optional(),
});
export type Touched = z.infer<typeof Touched>;
/** A field's value before a run, as `Touched.before` keeps it (#206). */
export type FieldBefore = NonNullable<Touched['before']>[string];

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

/**
 * A feed the gardener follows (#159, Reader module), under `feeds`.
 * Its id is derived from its URL (`feedId`), so an OPML import works
 * offline and importing twice is once. The app writes the first block;
 * the fetcher (a function) keeps the second, and the app leaves it be.
 */
export const Feed = z.object({
  /** The feed itself (RSS, Atom or JSON Feed). */
  url: z.string(),
  title: z.string(),
  /** The site the feed is for, when known. */
  site: z.string().optional(),
  /** Folder names; none means Uncategorized. A feed can be in several. */
  folders: z.array(z.string()),
  addedAt: Timestamp,
  updatedAt: Timestamp,
  /** When the fetcher should look next; the app sets it to now on adding. */
  nextFetchAt: Timestamp.optional(),
  // The fetcher's own (#161): conditional-request tokens, when it last
  // looked, its adaptive interval in minutes, errors and their count,
  // the newest item seen, and whether it has given the feed up.
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  fetchedAt: Timestamp.optional(),
  claimedAt: Timestamp.optional(),
  interval: z.number().optional(),
  errorCount: z.number().optional(),
  error: z.string().optional(),
  lastItemAt: Timestamp.optional(),
  dead: z.boolean().optional(),
  /**
   * Set by the fetcher once the feed's items carry audio (#178), and
   * never unset: the Reader shows its episodes on the Podcasts shelf.
   */
  kind: z.enum(['podcast']).optional(),
});
export type Feed = z.infer<typeof Feed>;

/** A web link, http or https only (#178), for what a feed points at. */
const WebUrl = z.string().regex(/^https?:\/\//i);

/**
 * An item's audio (#178): a podcast episode's file, as the feed gave
 * it. `bytes` is the feed's stated length, `seconds` its duration.
 */
export const Enclosure = z.object({
  url: WebUrl,
  type: z.string(),
  bytes: z.number().int().nonnegative().optional(),
  seconds: z.number().int().nonnegative().optional(),
});
export type Enclosure = z.infer<typeof Enclosure>;

/** Reader mode on an item (#163): asked, claimed, kept, or why not. */
export const ReaderState = z.enum(['requested', 'working', 'done', 'failed']);
export type ReaderState = z.infer<typeof ReaderState>;

/**
 * One article from a feed (#159), under `feedItems`, written by the
 * fetcher; its id is derived from the feed and the item's guid or link,
 * so a refresh never duplicates. The app may change only `read`,
 * `readAt`, `saved`, `attachmentId`, `noteId` and `updatedAt`
 * (firestore.rules), the last two when it saves or files one (#163).
 * Content is kept
 * on the document, as the app's markdown, so an article once loaded
 * reads offline.
 */
export const FeedItem = z.object({
  feedId: z.string(),
  title: z.string(),
  link: z.string(),
  author: z.string().optional(),
  published: Timestamp,
  /** The first lines, plain text, for the compact list. */
  summary: z.string(),
  /** What the feed gave, as markdown, capped. */
  content: z.string(),
  read: z.boolean(),
  readAt: Timestamp.optional(),
  saved: z.boolean(),
  /** The reading-queue record made by Save for later (#163). */
  attachmentId: z.string().optional(),
  /** The clipping made by File in the garden (#163). */
  noteId: z.string().optional(),
  readerState: ReaderState.optional(),
  readerContent: z.string().optional(),
  readerError: z.string().optional(),
  /**
   * When a TTL policy removes it (#171): set by the fetcher from the
   * gardener's keep-for months; the app may only clear it (saving or
   * filing keeps an article).
   */
  expireAt: Timestamp.optional(),
  /**
   * A podcast episode's audio, its artwork and its number (#178),
   * written by the fetcher; an item with an enclosure is an episode.
   */
  enclosure: Enclosure.optional(),
  image: WebUrl.optional(),
  episode: z.number().int().positive().optional(),
  /**
   * The owner's listening marks (#179): where the episode was left, in
   * seconds, when, and whether it was heard to the end. Written by the
   * player; the newest playedAt is the one other devices offer.
   * playedAt is the writing device's clock at the write, not the
   * server's at the sync (Eric, 2026-11-07), and never more than a
   * minute behind the stored one, nor more than a minute ahead of the
   * server: the rules refuse either (#190).
   */
  position: z.number().nonnegative().optional(),
  playedAt: Timestamp.optional(),
  played: z.boolean().optional(),
  /**
   * The word index (#175): up to 200 distinct stemmed lowercase words
   * of the title and text (`termsOf` in the functions' reader), which
   * search asks for with `array-contains`. Written by the fetcher, and
   * again when reader mode keeps the page's text; never the app's.
   */
  terms: z.array(z.string().max(40)).max(200).optional(),
  /**
   * Labels the server gives an article (#176): a Feedly board it was
   * on becomes a tag (Eric, 2026-11-07). Written by the import, never
   * by the app; the owner's update rule leaves it out.
   */
  tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type FeedItem = z.infer<typeof FeedItem>;

/** The Reader's own settings (#159), one doc, `settings/reader`. */
export const ReaderSettings = z.object({
  /** Folder names in the order the gardener wants them; the rest follow, sorted. */
  folderOrder: z.array(z.string()),
  /** Whether articles show their images. */
  images: z.boolean(),
  /**
   * Months to keep an article neither saved nor filed (#171); unset
   * keeps everything. The fetcher writes `expireAt` from it and a TTL
   * policy removes what expires.
   */
  keepMonths: z.number().int().min(1).max(120).optional(),
  /** Mark articles read as they scroll past in the list (#172). */
  readOnScroll: z.boolean().optional(),
  /** When each folder's list was last opened, folder name to time (#173). */
  seenAt: z.object({}).passthrough().optional(),
  updatedAt: Timestamp,
});
export type ReaderSettings = z.infer<typeof ReaderSettings>;

/**
 * The assistant's own switches (#214), one doc, `settings/assistant`,
 * written by the app; the functions read it. Its own doc, as the
 * modules', since `settings/keys` is the functions' alone.
 */
export const AssistantSettings = z.object({
  /**
   * Garden new notes on arrival (#214, step 1 of #155): a plain text
   * note of the gardener's, once it first settles, is sent to the
   * garden's agent with no ask and done at once on the Anthropic key.
   * Off when absent.
   */
  gardenOnArrival: z.boolean().optional(),
  updatedAt: Timestamp,
});
export type AssistantSettings = z.infer<typeof AssistantSettings>;

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
  /** The garden's own agent runs (#144 step 3), function-written. */
  runs: (uid: string) => `users/${uid}/runs`,
  run: (uid: string, id: string) => `users/${uid}/runs/${id}`,
  proposals: (uid: string) => `users/${uid}/proposals`,
  attachments: (uid: string) => `users/${uid}/attachments`,
  /** The Reader (#159): the feeds followed, their articles, its settings. */
  feeds: (uid: string) => `users/${uid}/feeds`,
  feed: (uid: string, id: string) => `users/${uid}/feeds/${id}`,
  feedItems: (uid: string) => `users/${uid}/feedItems`,
  feedItem: (uid: string, id: string) => `users/${uid}/feedItems/${id}`,
  reader: (uid: string) => `users/${uid}/settings/reader`,
  /** The assistant's switches (#214), e.g. garden on arrival. */
  assistant: (uid: string) => `users/${uid}/settings/assistant`,
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
