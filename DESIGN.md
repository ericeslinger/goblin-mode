# Goblin Mode: technical design

Goblin Mode is a single-user, offline-first notes PWA at
mossgoblin.garden, with Claude as a first-class editor through an MCP
server. The product and UX are specified in the UX spec (Claude Docs,
"Goblin Mode UX Spec"); this file is how we build it. Decisions are
dated in place. Open ones live in QUESTIONS.md.

## Stack (2026-10-05)

The Angular + Firebase + Cloudflare stack playbook is the baseline. Where
Goblin Mode differs, the reason is written here.

| Layer | Choice | Notes |
| --- | --- | --- |
| Client | Angular 22, standalone, zoneless, signals | PWA via `@angular/service-worker` |
| Data | Firestore with persistent local cache | Offline-first comes from the cache |
| Files | Cloud Storage for Firebase | Phase 2 (attachments, photos) |
| Auth | Firebase Auth, Google sign-in | One owner account |
| Server | Cloud Functions v2, bundled with esbuild | MCP, titles, push, history |
| Hosting | Cloudflare Worker + Static Assets | Apex domain mossgoblin.garden |
| Push | Firebase Cloud Messaging, web push | Android installed PWA |
| Tests | Vitest units, Playwright journeys on emulators | `npm run gate`, `npm run e2e` |

**No SSR (2026-10-05).** The playbook uses Angular SSR when pages must be
public and indexable. Nothing here is public, and the launch screen must
open from the service worker cache with no network, so the client is a
static SPA. The Worker exists only to serve assets and to proxy the
server routes below to Cloud Functions under the same origin.

## Repository layout

```
packages/
  schema/      the zod contract and pure logic; client and functions import it
  editor/      note grammar and CodeMirror editor; no Angular (see Editor)
  frontend/    Angular PWA
  functions/   Cloud Functions (esbuild bundle, no devDependencies)
  e2e/         Playwright journeys against the emulator suite
  rules-tests/ allow/deny suites for firestore.rules
infra/worker/  Cloudflare Worker: static assets + same-origin proxy
scripts/       gate, e2e, deploy helpers
firestore.rules, storage.rules, firebase.json
```

npm workspaces, one lockfile at the root. Build tools (typescript,
esbuild, vitest, prettier, firebase-tools, wrangler, playwright) are root
devDependencies so the functions manifest stays free of them. Functions
are one handler per file in concept directories; `index.ts` is wiring,
and `boundary.spec.ts` freezes the exported names.

## Data model

Everything lives under the owner's uid, so the rules are one line of
ownership and the MCP server reads the same paths as the app.

```
users/{uid}
  notes/{noteId}
    history/{versionId}
  reminders/{reminderId}
  devices/{deviceId}          push tokens
  activity/{runId}            "What Claude changed" records
oauth/...                     MCP auth state, server-only
```

Ids are generated client-side (Firestore auto ids) so a note exists the
moment it is created offline.

The zod schemas in `packages/schema/src/model.ts` are the contract; the
interfaces below are their shape. **Write path per collection
(2026-10-05):** `notes`, `reminders` and `devices` are written directly
by the client, because capture, done and snooze must work offline; they
are owner-only and nothing is derived from them by rules.
`notes/history`, `activity` and `oauth` are function-only
(`allow write: if false`). Direct-write collections get rules shape
validators generated from the schemas (`npm run rules:gen`, from
`packages/schema/src/rules`), and `npm run gate` fails when the
committed rules are stale (built 2026-10-06). Refinements (regex, min
length) and list or map contents are not checked by the rules, only
their types. Claude's MCP writes go through functions and are parsed
against the same schemas.

### Note

```ts
interface Note {
  kind: 'text' | 'sketch' | 'concept';
  body: string;                 // markdown-lite
  title: string;                // shown title
  titleSource: 'words' | 'llm' | 'user';
  conceptType?: 'person' | 'project' | 'other';  // kind == 'concept'
  synonyms?: string[];          // kind == 'concept'
  links: string[];              // note ids this note links to
  tags: string[];               // e.g. 'feelings'
  archived: boolean;            // merged away by Claude, kept for undo
  mergedInto?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  updatedBy: 'user' | 'claude';
  deviceId: string;             // last writer, for conflict history
}
```

A concept is a note with `kind: 'concept'`. People and projects will
extend it with their own fields once those are known (2026-10-05: left
open on purpose). Backlinks are a query on `links array-contains id`,
plus a synonym text match in Phase 2.

### Reminder

```ts
interface Reminder {
  text: string;
  dueAt?: Timestamp;            // none = Someday
  recurrence?: { freq: 'daily' | 'weekdays' | 'weekly'; time: string; tz: string };
  status: 'open' | 'done' | 'snoozed';
  snoozedUntil?: Timestamp;
  nextFireAt?: Timestamp;       // drives push; null when nothing to send
  noteId?: string;
  template?: string;            // e.g. 'feelings': tap opens a new note from it
  createdBy: 'user' | 'claude';
}
```

## Client

**Launch.** The service worker serves the app shell from cache, so the
editor renders and takes focus before Firestore or auth have finished.
Auth state is restored from IndexedDB; until it resolves and the
first notes snapshot arrives, typing goes into a pending draft kept in
localStorage (so a reload cannot lose it) and is written to Firestore
after. Waiting for the snapshot means a write can tell a new note from
one this device has not seen yet, and never overwrites it. Any later
direct save clears the draft, so an older draft never lands on newer
text.

**Signed out (Eric, 2026-10-06).** A signed-out visitor sees only a
sign-in screen, never the editor. To keep launch instant, the device
remembers that it has been signed in: with that mark set, the editor
shows at once while Firebase restores the session, and if the session
turns out to be gone the app switches to sign-in; the pending draft
stays in localStorage and becomes the first note after sign-in.

**New or resume.** On `visibilitychange` to hidden, and on `pagehide`,
the app stores the time and the open note id in localStorage. On
visible or cold start, more than 5 minutes since that stamp opens a
fresh note; otherwise the stored note reopens. "Previous note" opens a
short list of recent notes. A note is only written once something is
typed, so a fresh note left untouched never exists.

**Saving (as built, 2026-10-06).** `CaptureService` writes 300 ms after
typing pauses, and at once when the app is hidden. `NotesService`
writes a new note's full shape (what the rules require), then merged
updates of body, title, `updatedAt` (server time), `updatedBy` and
`deviceId`, so fields set elsewhere (Claude's links, a title Eric
chose) survive. Writes land in the persistent cache at once and sync
later; the UI never waits on them. A note emptied by typing is deleted
when you leave it; an untouched note never is, since its text may not
have loaded yet. Bodies are stored with `\n` line endings (CodeMirror
normalises `\r\n`; accepted 2026-10-06).

**Lists and search.** One live listener on the user's whole `notes`
collection, newest first, feeds Recent, Previous note and search; one
person's notes are small enough, and the cache answers it offline.
Search is every typed word, case-insensitive, in title or body. A real
index waits until this is slow.

**Conflicts.** Last write wins (2026-10-05). A Firestore trigger copies
the previous version into `history` when the writer's `deviceId`
changes or the last snapshot is older than 10 minutes, so an
overwritten edit can be recovered from the note's History.

**Titles.** The client shows the first words until a better title
arrives. A trigger on note writes asks a small Claude model for a title
when the first paragraph changes and `titleSource` is not `user`, using
one server-side API key (secret `ANTHROPIC_API_KEY`). No key, or an
error, leaves the first-words title.

**Layout.** One column on the phone (capture on top, Right Now below);
two panes from 900 px (list left, note right). The handle between note
and Right Now is a separator: drag it, or use the arrow keys, to give
Right Now between 15% and 80% of the screen (Home and End jump to the
limits), saved on the device when the drag ends (Eric, 2026-10-06).
Tapping the Right Now heading opens the full list (`/right-now`). On
wide screens Right Now sits above the notes list, as the UX spec has
it, sized by its content (2026-10-06).

**Right Now (as built, 2026-10-06).** One live listener on open and
snoozed reminders (`status in ['open', 'snoozed']`; done ones are never
read). A reminder's time is its snooze while snoozed, else `dueAt`;
before now is Overdue, later today (the device's time zone) is Today,
after that Soon, and no time at all is Someday. The launch panel shows
up to three Overdue and Today items, soonest first, with "N more"
linking to the full list. The sort re-runs every 30 seconds, so items
slide into Overdue while the app is open.

- **Done** finishes a one-off (`status: 'done'`, times removed). A
  repeat stays open and moves `dueAt` to its next occurrence after both
  now and its current due time, so finishing early does not repeat the
  same day.
- **Snooze** keeps `dueAt` and sets `snoozedUntil`: in an hour, tonight
  (8 pm, offered until 7 pm), tomorrow (9 am), or a picked time.
- **Undo** is offered for six seconds after either, and writes the old
  times back.
- **Swipe** right is done, left opens snooze; the Done and Snooze
  buttons on every row do the same for keyboards and screen readers.
- **Add** takes text, an optional time and an optional repeat (daily,
  weekdays, weekly). A repeat stores the local time and the device's
  IANA zone; weekly keeps the weekday of its first time, and a repeat
  with no time starts at 9 am. Add waits until the user is known.
- `nextFireAt` is the time a push should go out: `dueAt` on add, the
  snooze when snoozed, the next occurrence after done, removed when
  finished. Step 5's `sendDuePush` reads it.
- The rules live in `packages/schema/src/reminders.ts` (pure, epoch
  milliseconds), so the app and `sendDuePush` agree. A wall time skipped
  by a clock change fires just after the gap; a repeated one fires the
  first time.

Not yet: tapping a reminder opens its note only when it has `noteId`
(Claude sets it; the app has no way to link one yet), templates wait
for the feelings template, and calendar events are Phase 2.

## Editor (2026-10-06)

**Decision.** Notes are edited with CodeMirror 6 in the style of
Obsidian, with two modes over the same text: **live preview** (markdown
syntax hidden except on the line being edited; links, images and
checkboxes drawn as widgets) and **source** (plain markdown). The note
body is one markdown string, stored exactly as typed. Switching modes
only changes the display, so it can never rewrite or lose text.

**Emphasis (Eric, 2026-10-06).** `*text*` is bold and `_text_` is
italic; `**text**` and `__text__` stay bold. The grammar reads
single-star emphasis as strong (`grammar/emphasis.ts`), so the editor
and the HTML renderer agree. The stored text is unchanged, so tools
outside Goblin Mode still show `*text*` as italic; the MCP tools (step
7) tell Claude about the convention, so its own writing follows it.

**Why not TipTap/ProseMirror** (as overstory uses). A rich-text model
means converting markdown to the editor's document and back. Every
custom block would need a parse rule, an editor node, a serializer and
an HTML renderer that all agree, plus a passthrough node so unknown
syntax is not dropped, and the serializer would still normalise Eric's
text (`*x*` becoming `_x_`), against the verbatim-prose invariant.
overstory's editor shows those failure modes. The cost accepted here is
that live preview is not full WYSIWYG (syntax shows on the line being
edited) and its polish is ours to build.

**One grammar.** remark (unified), as in goblin, is the only markdown
parser. It drives the renderer, link and image extraction, the MCP
server, and the live-preview decorations, which follow the character
offsets remark records for each node. CodeMirror's own Lezer markdown
parser is not used for structure, so there are never two grammars to
keep in step. A custom syntax is added once (a remark extension) plus
one renderer; the editor widget reuses that renderer.

**The flavour.** CommonMark plus:

- `[[Note title]]` and `[[Note title|shown text]]` wiki links;
- images inline as `![caption](attachment:<id>)`, so a note embeds
  images without a block envelope. Reserved syntax for now: attachments
  arrive in Phase 2, and until then the renderer shows the caption;
- GFM task lists (`- [ ]`), with checkboxes tickable in live preview
  (Eric, 2026-10-06).

goblin's directive syntax (`:::aside`, `::embed{#id}`) waits until a
first custom block is needed (Eric, 2026-10-06).

**Modes (Eric, 2026-10-06).** Live preview is the default everywhere,
with source one tap away; the choice is remembered app-wide on the
device, not per note.

**Bundle size (Eric, 2026-10-06).** Not a constraint: one user, who is
not sensitive to load time or bandwidth. The editor ships in the
initial bundle (no lazy loading, so launch never waits on a chunk), and
the Angular budgets are raised to fit; the service worker caches it all
after the first visit.

**Built to be extracted.** The editor may later move into goblin (rich
authoring) and overstory (a simpler pipeline), or become a library for
all three. So it lives in `packages/editor` with no Angular and no
Firebase: the remark grammar, the renderer and the CodeMirror
extensions, each with unit specs. The app's Angular component is a thin
wrapper that passes text in and out. Things only Goblin Mode needs
(resolving `attachment:` ids, looking up wiki link targets) come in
through small interfaces rather than imports.

**As built (2026-10-06).** `@goblin/editor` exports the grammar on its
own (`@goblin/editor/grammar`: `parseNote`, `renderNoteHtml`,
`wikiLinkTargets`, `tasks`, `attachmentIds`; no CodeMirror or DOM, so
Cloud Functions can import it) and the editor (`createNoteEditor`,
`createAccessoryBar`). Wiki links are an mdast transform over text nodes
rather than a micromark extension: CommonMark already leaves `[[x]]` as
literal text, and the transform keeps exact source offsets. Inside a GFM
table, an aliased link must escape its pipe (`[[Vikas\|vik]]`), or the
pipe splits the cell. Live preview re-parses on every change and
decorates per line: a construct shows as typed while the selection is on
one of its lines. Keyboard: Mod-Enter toggles the task on the cursor
line, Mod-K inserts a wiki link. Enter in a list item starts the next one
(same bullet, next number, an unticked box after a task); Enter on an
empty item ends the list, or moves a nested one out a level. The
grammar decides what is a list item, so Enter is plain inside code and
on `- - -`. Off the edited line, `-`, `*` and `+` markers
draw as bullets (Eric, 2026-10-06). A note opens with the caret at its
end. The launch route is eager, so the editor is in the initial bundle
(1.24 MB raw, about 330 kB over the wire; 1.74 MB raw once capture
added Firestore's live queries). Budgets: warn at 2 MB raw, fail at
8 MB, so growth is noticed without blocking.

Two things learned building it:

- Widgets inside the editor (checkboxes, link chips) are not reachable
  by role: browsers expose a textbox's contents as text only. Screen
  reader and keyboard users get the same actions through the
  shortcuts; journeys find widgets by aria-label within the note.
- CodeMirror applies Enter on Android only after the browser's own DOM
  change, so Playwright's phone profile (an Android user agent) can drop
  an Enter typed instantly before more text. Journeys wait for the new
  line before typing on.

**Reused from the other repos.** goblin: the remark pipeline and its
directive syntax, if custom blocks are wanted. overstory: the touch
accessory bar that docks above the keyboard using `visualViewport`,
shown only while the keyboard is open because Android's back button
closes the keyboard without blurring the editor.

## Server routes

The Worker serves the static app and forwards these paths to Cloud
Functions, so the MCP endpoint and OAuth live on mossgoblin.garden:

| Path | Function | Purpose |
| --- | --- | --- |
| `/mcp` | `mcp` | MCP over Streamable HTTP |
| `/.well-known/oauth-protected-resource` | `oauth` | MCP auth discovery |
| `/.well-known/oauth-authorization-server` | `oauth` | Authorization server metadata |
| `/oauth/register`, `/oauth/token` | `oauth` | Dynamic client registration, token exchange |
| `/oauth/authorize` | client route | Google sign-in, then consent |

Other functions: `noteHistory` and `noteTitle` (Firestore triggers),
`sendDuePush` (scheduled every minute).

## MCP server

claude.ai custom connectors speak MCP over Streamable HTTP and sign in
with OAuth 2.1 (PKCE, dynamic client registration). The function is an
OAuth authorization server whose only identity provider is the owner's
Firebase Google sign-in:

1. claude.ai registers a client and sends you to `/oauth/authorize`.
2. That page (in the Angular app) signs you in with Google, then posts
   the Firebase ID token and the PKCE request to the function.
3. The function checks the token's uid is the owner, issues a one-time
   code, and redirects back to claude.ai.
4. `/oauth/token` exchanges the code for an access token and refresh
   token. Tokens are random, stored hashed under `oauth/`, revocable.

The owner uid is a function parameter (`OWNER_UID`,
`DjudV1dnNxdpn7XP1VTluVJMLNb2` in `mossgoblin-garden`); any other
account is refused. MVP tools:

| Tool | Does |
| --- | --- |
| `search_notes` | Full-text-ish search over titles, bodies, synonyms |
| `list_notes` | Recent notes, optionally since a time |
| `get_note` | One note with its links and backlinks |
| `create_note`, `update_note` | Write notes (`updatedBy: 'claude'`) |
| `list_reminders`, `create_reminder`, `update_reminder` | Right Now |

Phase 2 adds `merge_notes`, `archive_note`, `add_synonym`,
`import_url`, `record_activity`. Claude has full read-write access
(2026-10-05); the rule that it keeps your paragraphs verbatim is in the
tool descriptions, and merges archive originals instead of deleting.

Search in the MVP is a scan of the owner's notes in the function
(hundreds to low thousands of documents). A real index waits until it
is slow.

## Push

The app registers an FCM token per device in `devices`. `sendDuePush`
runs every minute, finds reminders with `nextFireAt <= now`, sends one
web push each, and advances `nextFireAt` (next occurrence for recurring
reminders, cleared otherwise). Tapping a notification opens the
reminder's note, or a new note from its template.

**As built (2026-10-06).**

- **Registering.** Settings has Turn on / Turn off notifications. On
  asks the browser, gets an FCM token with the project's Web Push key
  and writes `devices/{deviceId}` (the same device id notes carry).
  Once on, every sign-in refreshes the token, since FCM rotates them.
  Off deletes the device record and the token, and signing out turns
  the device off first, so a signed-out or shared browser stops getting
  reminder text (deleting the token is the guarantee; the record also
  goes once FCM reports the token gone). On localhost there is
  no FCM emulator, so the device registers a stand-in token and the
  flow still runs end to end.
- **One service worker.** The app keeps Angular's `ngsw-worker.js`
  and FCM subscribes through its registration, so there is no
  `firebase-messaging-sw.js`. Angular's worker shows any push whose
  JSON has `notification.title`, and a tap follows
  `notification.data.onActionClick` (`navigateLastFocusedOrOpen`).
  Not testable without real FCM: check on the phone after deploy.
- **Sending.** `sendDuePush` (every minute, no retries) reads up to
  100 due reminders with a collection-group query (its index is in
  `firestore.indexes.json`), then for each one claims it in a
  transaction (moves `nextFireAt` only if it is unchanged, so a done or
  snooze from the app, or an overlapping run, wins) and only then
  sends. A failed send loses one nudge; nothing is ever sent twice.
  Tokens FCM reports gone are deleted with their device. A push goes
  to the devices registered when it falls due: with none, the reminder
  is still claimed (and still shows in Right Now) rather than held for
  a device that may come later, which would deliver a burst of stale
  nudges and re-read every held reminder each minute (2026-10-06).
- **What is sent.** Title: the reminder's text. Tap: its note, else
  Right Now. One notification per reminder (`tag` is its id).
- **Repeats** keep nudging: after a push a repeat's `nextFireAt` moves
  to its next occurrence while `dueAt` stays, so an ignored reminder
  sits in Overdue and still pushes the next day (`nextPushAfter` in
  `packages/schema/src/reminders.ts`). One-offs push once.
- Templates (the feelings note) wait for Phase 2: until then a tap on
  a template reminder opens Right Now.

## Security

**Only one account exists (2026-10-05).** End-user sign-up is disabled
in Firebase Auth and Eric's account was created by hand in the console,
so a stranger cannot get a uid at all; that settles the open-sign-in
cost exposure. The rules stay uid-scoped rather than hard-coding the
owner uid, so the emulator and rules tests need no special account.

Google sign-in. Firestore rules allow only `request.auth.uid == uid`
under `users/{uid}`, and only for the write path each collection has:
the client writes `notes`, `reminders` and `devices`; `notes/history`
and `activity` are read-only to the client; anything unlisted, and
`oauth/`, is denied. Storage is deny-all until attachments (Phase 2)
decide its write path.
No end-to-end encryption, so MCP and search can read notes (2026-10-05).
Firestore point-in-time recovery (7 days) is the backstop for bad edits,
and a weekly scheduled Firestore backup covers anything older (both set
up by Eric, 2026-10-05).

## Delivery

Per the playbook: `npm run gate` before each commit, `npm run e2e`
before a PR, the PR review agent on every PR, and the coding agent
merges when review approves, both gates are green on the head, and the
change touches no schema. Schema or data migrations wait for Eric.

**Deploy-only workflow (2026-10-05).** The playbook has no GitHub
Actions at all. Goblin Mode adds one workflow, `deploy.yml`, that runs
on push to `main` and only builds and deploys (rules, functions,
Worker). Gates stay local because there are not enough Actions minutes
for CI. It needs two repository secrets: `CLOUDFLARE_API_TOKEN` and
`FIREBASE_SERVICE_ACCOUNT`.

The app shows its build sha and time in Settings so a refresh can be
checked against the deploy.

## Build order

Each step is one or more PRs, each with a journey.

1. Scaffold: workspaces, gates, emulators, hook, review agent, deploy
   workflow, an app shell that signs in. Done 2026-10-05.
2. Editor: `packages/editor` with the remark grammar, renderer, live
   preview and source modes, the touch accessory bar, and the Angular
   wrapper.
3. Capture: launch screen on the new editor, signed-out screen,
   autosave, offline, new-or-resume, Previous note, Recent list and
   search, two-pane layout; the rules shape-validator generator.
   Done 2026-10-06 (wiki links do not open notes yet).
4. Reminders: Right Now panel and full list, add, done, snooze,
   recurring. Done 2026-10-06.
5. Push: device registration, `sendDuePush`, notification taps.
   Built 2026-10-06, with the Web Push key set the same day.
6. History and titles: `noteHistory`, `noteTitle`.
7. MCP: OAuth, tools, connector set up in claude.ai.

First deploy to mossgoblin.garden: done 2026-10-06.
