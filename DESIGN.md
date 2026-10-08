# Mossgoblin: technical design

Mossgoblin is a single-user, offline-first notes PWA at
mossgoblin.garden, with Claude as a first-class editor through an MCP
server. The product and UX are specified in the UX spec (Claude Docs,
"Mossgoblin UX Spec"); this file is how we build it. Decisions are
dated in place. Open ones live in QUESTIONS.md.

## Stack (2026-10-05)

The Angular + Firebase + Cloudflare stack playbook is the baseline. Where
Mossgoblin differs, the reason is written here.

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
  settings/app                theme and mode, shared by devices
  activity/{runId}            "What Claude changed" records
oauth/...                     MCP auth state, server-only
```

Ids are generated client-side (Firestore auto ids) so a note exists the
moment it is created offline.

The zod schemas in `packages/schema/src/model.ts` are the contract; the
interfaces below are their shape. **Write path per collection
(2026-10-05):** `notes`, `reminders`, `devices` and `settings` (#24,
2026-10-06) are written directly by the client, because capture, done and snooze must work offline; they
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
  conceptType?: 'person' | 'project' | 'mood' | 'other';  // kind == 'concept'
  synonyms?: string[];          // kind == 'concept'
  parent?: string;              // conceptType == 'project' (#41)
  projectKind?: 'build' | 'content';
  projectStatus?: 'active' | 'nearly-done' | 'maintenance' | 'waiting' | 'done' | 'new';
  links: string[];              // note ids this note links to
  tags: string[];               // e.g. 'feelings'
  archived: boolean;            // merged away by Claude, kept for undo
  mergedInto?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  updatedBy: 'user' | 'claude';
  deviceId: string;             // last writer, for conflict history
  settledAt?: Timestamp;        // last left after a change; asks for a title
}
```

A concept is a note with `kind: 'concept'`. People and projects will
extend it with their own fields once those are known (2026-10-05: left
open on purpose).

**Links and concepts (#28, 2026-10-07).** The note shape did not need
to change: `links`, `kind: 'concept'`, `conceptType` and `synonyms`
were in the contract from the start, so the rules are unchanged.
`packages/schema/src/concepts.ts` says how a `[[name]]` becomes an id:

- `normalizeName` compares names Unicode-normalized, case-folded and
  with spaces collapsed.
- A concept's id is derived from its name, `conceptId(name)`: `c-` and a
  slug (letters and digits in any script, words joined by hyphens).
  When the slug does not spell the name exactly (punctuation, accents,
  a long name cut short) an 8-digit hash of the name follows, so `C`,
  `C++` and `C#` stay three concepts. Two devices linking the same new
  name offline make one concept. Auto ids never contain `-`, so a
  concept id never collides with a note id. Renaming keeps the id and
  adds the old name as a synonym (#29). The derivation names every
  concept document, so changing it later is a migration.
- `nameIndex` maps names to ids: concepts' titles and synonyms first,
  then other notes' titles; archived notes are left out, so a link
  follows a merge.
- `resolveLinks` turns a note's link targets into ids, and a name
  nothing answers to points at the concept it would make (the stub is
  created on settle, #29).

**Editing links (#29, 2026-10-07).** Typing `[[` (or the accessory
bar's `[[` button) opens suggestions from `suggestLinks` in the schema:
names that start with what is typed before names that contain it,
concepts (by title or synonym, offered by title) before notes, and the
typed name itself as a new concept when nothing matches it exactly.
Picking one writes `name]]`. A tapped link chip opens its note at
`/n/<id>`, pushing history; a name nothing answers to becomes a stub
concept first. Leaving a note that was typed in also plants stubs for
its new names (`NotesService.plantConcepts`). A stub is a note with
kind `concept`, the name as written as its title (`titleSource: 'user'`,
so a settle never retitles it), type `other` and no text. It is made in
a transaction that writes only if the concept does not exist, so it can
never replace a concept another device or Claude made (review on #65).
A transaction needs the server, so a name linked offline, or before the
notes load, waits on the device (`goblin.pendingConcepts`) and is made
when the notes load or the device comes back online; until then its
page says so and is read-only. MCP writes do not plant stubs; a link
from Claude to a new name points at the concept id, and the stub
appears when the gardener follows it or leaves a note linking it.

The editor reports only the user's edits: text the app loads into it
(another note opened) is neither reported back as typing nor undoable,
so opening a note never marks it edited, and undo never brings back
another note's text (found with #29: an empty concept was deleted as
"emptied by typing" the moment it opened).

**Concept page (#30, 2026-10-07).** A concept opens at `/n/<id>` like
any note, with a header above its text: its name (renaming keeps the
id and adds the old name as another name, so links written with it
still land), its type (person, project, other) and its other names,
added and removed as chips (`NotesService.updateConcept`). A name
another note already answers to is refused, so a concept never takes
over another's links; an empty stub that holds it (made by linking the
name earlier) is folded in instead, archived with `mergedInto`. A
concept is never deleted for having no text. Under any
note, **Linked from** lists the notes that link to it, each with the
sentence the link sits in, and under a concept **Often together**
lists the concepts most often linked from the same notes.
`LinksService` builds this graph from note bodies resolved against
today's names (the schema's `backlinks`, `oftenTogether` and
`sentenceAround`), parsing each body once per change, so older notes
with empty stored `links` count, and a synonym added today links notes
written last week.

**Projects (#41, Eric, 2026-10-08).** A project is a concept with
`conceptType: 'project'` and three real fields: `parent` (another
project), `projectKind` (build or content) and `projectStatus` (new,
active, nearly done, maintenance, waiting, done). Every project has
one layout, its sections held in its own text, in this order:
Overview, Working notes, Tasks, Ideas, Open questions, Decisions,
Links. Becoming a project (in the app, or through `refile` and
`create_concept`) adds the missing headings with `withProjectSections`
(`packages/schema/src/projects.ts`); text already there goes under
Overview word for word. Tasks are both a checklist under the Tasks
heading and reminders with `noteId` set to the project, shown live
in the concept header with Done and a "+ task" field. The header also
picks the parent (never the project itself or one under it,
`canParent`), kind and status, and lists the projects one level
under it. Browse, Projects, shows the tree with a status filter; a
project whose parent is filtered out stands at the top.

**Feelings journal (#40, Eric, 2026-10-08).** Moods are concepts of
type `mood`, not tags. Settings, Add a feelings journal, makes an
entry template (`FEELINGS_TEMPLATE`, with a `Moods:` line) and three
daily reminders linked to it, at breakfast, lunch and dinner
(`FEELINGS_TIMES`). A reminder's link and its push carry
`?from=reminder`, and a reminder to a template opens a new entry from
it, in place of the link. On a Moods line, typing a mood offers the
moods used before and the typed name as a new one; picking writes it
as a `[[link]]` followed by a comma. A name first linked on a Moods
line is made a concept of type mood (`moodTargets`), so a mood's
page lists every entry naming it. Browse, Journal, lists notes with a
Moods line, each with its date and moods.

**Garden this (#42, 2026-10-08).** The `capture` MCP tool files chat
words under a project, verbatim. An idea becomes its own note: Claude's
one-line summary marked `✳ Claude:`, the words, the source link, and
`Part of [[Project]]`, listed under the project's Ideas by name (a
taken name gets the date). A decision is a dated line under Decisions,
a question a line under Open questions, and `remind` adds a reminder
linked to the project. The repo skill `.claude/skills/garden-this`
tells Claude Code to offer this at the end of a session. Text shared
from another app (the manifest's `share_target`, GET to `/` with
title, text and url) opens as a new note holding it. An idea's note
and its line under Ideas are one transaction, so a retry never files
twice; its name drops brackets and bars, and a taken one gets the
date, then a count. A reminder that cannot be made is reported, not
thrown, since the words are already filed (review on #97). Chrome
picks up a changed manifest for an installed PWA on its own schedule,
usually within a day, so Share to Mossgoblin may take that long to
appear.

**Sharing files in (#46, 2026-10-08).** The manifest's share target
is a multipart POST to `/share`, taking title, text, url and files
(images and PDFs). The app's service worker is `sw.js`: it answers
that POST itself, keeps the files in the `mossgoblin-share` cache,
and redirects to `/?title&text&url&shared=<n>`; then it imports
Angular's `ngsw-worker.js` for everything else. Launch opens a new
note with the words and puts the files in through the same path as
the attach button. A share that reaches the Cloudflare Worker before
the service worker is installed keeps its words; its files cannot be
kept there, so the app says to share them again. In the editor, a
pasted or dropped image or PDF goes in the same way. Review on #98:
a paste that also carries text is the editor's own text paste (a
spreadsheet copy brings a picture of itself), while a drop of files
is always files. Files shared while signed out wait in the cache and
go into a new note when the editor first shows; ones over a day old
are dropped. A share must come from this device: `sw.js` and the
Worker refuse a POST whose `Sec-Fetch-Site` is cross-site or
same-site, or whose referrer is another origin, and the app ignores
`?text=` opened from another site's page, so a page cannot plant
text Claude would later read. Android's share sheet should send none of
those; that, and the move of every installed copy from
`ngsw-worker.js` to `sw.js` (same scope, caches and push
subscription), want a check on the phone after the deploy.

Every write stores the result: the app's `NotesService.save` and the
MCP tools both parse the body with the grammar (`wikiLinkTargets`, so a
`[[name]]` inside code is not a link). Notes written before this keep
`links: []` until their next write; rather than backfill them (a data
migration), readers derive links from bodies: MCP `get_note` finds
backlinks by resolving every note's body, and the app's backlinks and
maps (#30, #32) do the same from the notes it already holds.

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
  template?: string;            // a template's id: its schedule (#36)
  createdBy: 'user' | 'claude';
}
```

### Templates (#36, 2026-10-07)

A template is a note of kind `template`, not a collection of its own,
so it syncs, links, keeps History and is edited like any note. Its
`templateMode` is `living` (one note reused, like the shopping list)
or `entry` (a new note each time, like a journal entry). A note made
from it records the template's id in `fromTemplate`. Template ids are
generated like any note's.

- **Instructions for Claude** are a section of the body, under a
  heading of that name at any level, running to the next heading of
  the same level or higher. `templateParts` (schema) splits a body
  into that section and the skeleton a new note starts from.
- **The schedule** is a recurring reminder whose `template` names the
  template, so it needs no field of its own: tapping it opens the
  template's note (a fresh entry, or the living note).
- **Readers are lenient.** A template with no `templateMode` is used
  as `entry`, and `templateMode` on any other kind is ignored; the
  schema and rules do not tie the two together.
- A heading-like line inside a code block is still read as a heading
  by `templateParts`.
- The rules accept the two fields through the generated note
  validator.

**Using templates (#38, 2026-10-07).**

- **Making one.** Settings, Templates, lists them (name and mode) and
  makes new ones: New template (entry) or New living template. A new
  template starts as a name to change and an empty Instructions for
  Claude section, and opens to be written. On its page a header says
  what a template is and switches the mode.
- **From template**, beside New on the launch screen when any exist,
  opens a menu of them. An entry template makes a new note from the
  skeleton; a living one reopens its note (the newest live note made
  from it) or makes it the first time. The note is written whole at
  once (`NotesService.create`, through the cache, so offline too),
  then opens at its URL.
- **Kept apart.** Templates are not in Recent or Tags, Previous note
  or the garden beds; they are in Archived when archived, and their
  names still resolve links. An emptied template is never deleted, and
  a template is never settled, so Claude does not retitle it.
- **Claude.** `list_templates` returns each template's instructions,
  skeleton, mode and the reminders naming it; `use_template` returns
  the living note, or a new entry it makes (recorded in What Claude
  changed), with the instructions to follow. The server instructions
  point Claude at them.
- **Two living notes.** If a second device uses a living template
  before the first device's living note has synced to it, it makes
  its own, and the two diverge; nothing is lost, and the organize
  tools can merge them. A living note's id is not derived from the
  template's, because an offline device would then write over the
  other's note.
- **Not yet.** A reminder naming a template does not open it yet;
  that comes with the journal's daily reminder (#40).

**Shopping list (#39, 2026-10-07).** A living template, added from
Settings (Add a shopping list): Meal plan, then Produce, Butcher and
Dry goods (Eric, 2026-10-06), and Instructions for Claude: read the
meal plan, add what the meals need with `add_lines` under the right
heading, skip what is listed, keep his words, and ★ marks a staple.

- **List view.** A note made from a template that has checklist items
  gets List beside Source: each section's open items as large
  checkboxes, and everything ticked sunk to Got it at the bottom. Got it
  is a view, not a heading: a tick changes only that item's mark
  (`setDone`), so it merges cleanly with Claude's line edits (#37). The
  view edits through `CaptureService.replace`, which the editor merges
  with any typing, and reads `current`, the text as typed.
- **Done shopping** removes ticked items and unticks ticked staples (a
  ★ in the item), so they come back on the next list (`doneShopping`).
  It saves at once as its own writer (`KEEP_SUFFIX`, as a restore
  does), so History always keeps the list it cleared; a tick still
  waiting to save is saved first, so that list includes it. For eight
  seconds it offers Undo, which puts back what it cleared and only
  that (`merge3`), so an item Claude added meanwhile stays.
- A tick names its item by line and text: if a merged change moved the
  lines since the list was drawn, the item is found again by its text.

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

**Note URLs (#27, 2026-10-07).** Every note lives at `/n/<id>`, with
no slug (Eric, 2026-10-06); `/` is the capture note, the one the
five-minute rule picks and New replaces. Both are one route (a URL
matcher), so the launch screen is reused, and the route decides which
note is open: opening a note pushes `/n/<id>`, so back returns to the
note or list it came from. New turns the old capture note's history
entry into its `/n/<id>` before pushing `/` for the fresh one, so back
reaches it too. A linked note this device does not have yet (not
synced) is shown read-only with a status line until it arrives, so
typing can never land on top of it. Pushes, Browse, reminders and
History restores link to `/n/<id>`; the old `/?note=<id>` redirects.
Copy link copies the note's address. The Worker and the service
worker already serve any extensionless path as the app, offline too.

**Browse lenses (#31, 2026-10-07).** Browse looks at the garden
through lenses, each at its own URL (`/browse` for Recent,
`/browse/<lens>` for the rest) with a count: Recent (notes with text),
Concepts, People and Projects (concepts by type, each saying how many
notes link to it), Tags (notes grouped under each tag) and Archived
(archived notes, the only place they appear). The search box filters
within the lens. The filters are pure (`browse/lenses.ts`). On a wide
screen the launch screen's list pane stays on Recent.

**Neighborhood map (#32, 2026-10-07).** Map, beside History on a note,
opens `/map/n/<id>` (a lazy chunk, so capture never pays for it): the
note in the middle, the notes it links or that link it on an inner
ring, and the notes one more link out beyond the one they came through
(the schema's `neighborhood`, capped at 16 and 32, most connected
first, from the body-derived graph). The layout is radial and
deterministic (`map/layout.ts`), plain SVG with no graph library; the
frame fits the nodes but never shrinks below a full ring's, so a small
neighborhood keeps its scale. Tapping a node opens its note, and back
returns to the map. Each dot has a finger-sized tap target, and the
outer ring is labelled only while it has 12 notes or fewer (every dot
names itself on hover). The drawing is hidden from assistive tech; the
same notes are listed under it (Linked directly, Two links away) as
links. Before the notes load it says Loading, not empty.

**Garden and Timeline maps (#33, 2026-10-07).** Browse links to
`/map`, the whole garden in the same lazy chunk. Garden: every live
concept is a bed, most-linked first, laid on a square-ish grid; each
note with text is planted once, in the bed of the most-linked concept
it links, and notes that link none share a last bed, Not linked yet.
A bed draws at most 20 notes and says how many more. Timeline
(`/map/timeline`): the same beds as lanes (six at most, the rest
folded into Everything else), each note at when it was made. The
concept filter is in the URL (`?concept=<id>`), so back undoes it, and
a filtered lane holds every note linking the concept, not just the
ones planted in its bed; a filter naming no concept shows them all.
As on the neighborhood map, the drawing is plain SVG hidden from
assistive tech, every dot opens its note, and the same notes are
listed under it (Beds, Over time).

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

**History (as built, 2026-10-06).** `noteHistory` runs on every note
write and keeps the replaced version (a `NoteVersion`: body, title,
who wrote it from where, when, and why it was kept) when another
device wrote over it, when Claude wrote over Eric or Eric over Claude,
when ten minutes passed since the last kept version (or since the note
was created), or when the note was deleted. A write that leaves the
body alone (a title, a settle) keeps nothing. The rules are
`keepReason` in `packages/schema/src/history.ts`. The header's History
link lists a note's last 50 versions, newest first; opening one shows
it whole, and Restore puts it back. A restore writes as its own writer
(the device id plus `~restore`), so the text it replaces is kept too.
Versions are never pruned yet; one person's history is small.

**Titles.** The client shows the first words until a better title
arrives. A trigger on note writes asks a small Claude model for a title
when the first paragraph changes and `titleSource` is not `user`. No
credential, or an error, leaves the first-words title.

**Titles on settle (Eric, 2026-10-06; replaces "when the first
paragraph changes").** A note is settled when Eric leaves it: a fresh
note after five minutes away, New, or opening another note (the list,
Previous note, a link, a restore of another note). Leaving writes
`settledAt` (a server time, merged; body and `updatedAt` untouched) if
the note has text and changed since its last settle, so reading an old
note never calls Claude. `noteTitle` asks `claude-haiku-4-5` for two
to six words when `settledAt` moves, the note has four or more words,
and the title is not Eric's own; it writes `title` with `titleSource:
llm` only if the note is still at that settle. Between settles the app
keeps Claude's title rather than putting first words back. A settle
that has to wait for sign-in (the five-minute case at launch) is held
on the device and written once the notes load.

**Claude credentials: workload identity federation, no API key (Eric,
2026-10-06; replaces the `ANTHROPIC_API_KEY` secret planned on
2026-10-05).** `noteTitle` runs as its own Google service account,
`goblin-titles@<project>.iam.gserviceaccount.com`. The
Anthropic SDK asks the metadata server for that account's
Google-signed identity token (audience `https://api.anthropic.com`,
`format=full`, so it carries `email`) and exchanges it at
`/v1/oauth/token` for a short-lived Claude API token, refreshing it
before expiry. Anthropic trusts the token through a federation rule
pinned to the account's exact `sub` (numeric unique id) and `email`
and to the audience. The rule, organization, service account and
workspace ids are not secrets, but like everything specific to one
deployment they are GitHub variables, not committed (Deploy
configuration below); a rule that covers one workspace needs no
workspace id. Set up and tested on Eric's deployment 2026-10-06. There
is no secret to store, rotate or leak; billing stays on Eric's
Anthropic account. The emulator has no metadata server, so locally
titles fall back to first words and specs use a fake. Claude on
Vertex AI (keyless through ADC) was the alternative, rejected because
it moves billing and quotas to GCP.

**Layout.** One column on the phone (capture on top, Right Now below);
two panes from 900 px (list left, note right). The handle between note
and Right Now is a separator: drag it, or use the arrow keys, to give
Right Now between 15% and 80% of the screen (Home and End jump to the
limits), saved on the device when the drag ends (Eric, 2026-10-06).
Tapping the Right Now heading opens the full list (`/right-now`). On
wide screens Right Now sits above the notes list, as the UX spec has
it, sized by its content (2026-10-06).

**Top bar (#78, Eric, 2026-10-07).** The bar keeps what writing needs:
New, From template (when there are templates) and List or Text (on a
list). Everything else is under More: Browse (not on wide screens,
where the notes list is beside the note), Source or Preview, Map, Copy
link and History (for a note with a URL), and Settings. The sync dot
sits on the More button's corner, green or red, so offline is always
in sight, and offline the button also says so in words (not by colour
alone); the menu says it too, and a hidden status tells screen
readers. After a choice that stays on the note (Source or Preview,
Copy link) the cursor goes back to the note. More is a disclosure: it closes on choosing an item, on
Escape (back to its button) and on a tap outside.

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

## Themes (#23, 2026-10-06)

Eric chose all five style directions from the UX Spec, switchable
(2026-10-06): Herbarium (the default), Night Garden, Moss and Lantern,
Bog Goblin and Pixel Mossling, each light and dark.

- `packages/frontend/src/app/theme/themes.ts` is the only file that
  names colors, fonts, radii and border widths. `ThemeService` copies
  the active theme's tokens onto `<html>` as custom properties
  (`--bg`, `--surface`, `--ink`, `--quiet`, `--rule`, `--accent`,
  `--on-accent`, `--second`, `--good`, `--warn`, `--font-*`,
  `--radius-*`, `--border`), sets `data-theme` and `data-mode`, and keeps
  `theme-color` in step. Components and the editor read only tokens;
  `styles.css` maps them onto the editor's `--mg-*` names.
- Mode is light, dark, or follow the system (live, via
  `prefers-color-scheme`).
- **Per user (#24, 2026-10-06).** The choice lives in
  `users/{uid}/settings/app` (`Settings` in the schema; the theme ids
  are the schema's `ThemeId`, so the rules and the app agree).
  `ThemeSync` listens to it once signed in and adopts what another
  device chose (never the echo of its own pending write, which could
  briefly undo a newer choice); a choice made here is written through
  the persistent cache, never awaited. The device keeps its last choice under
  `goblin.theme` so the first paint is right before auth and offline.
  When there is no doc yet, a device that holds a choice uploads it;
  once there is one, the doc wins over a choice made while signed
  out. A choice made while sign-in is still being restored is held and
  written once the gardener is known, so it is not lost to the older
  doc.
- Fonts are self-hosted from `@fontsource`, not Google Fonts, so they
  work offline and make no third-party request. Every `@font-face` is
  declared, but a browser fetches a font only when text uses it, and
  the service worker caches woff2 files lazily.
- `themes.spec.ts` holds every theme and mode to WCAG AA: ink, quiet
  and accent at 4.5 to 1 on the page and on surfaces, text on accent
  fills at 4.5, and the sync dots at 3. The `themes` journey runs axe
  over Settings, Right Now and Browse in all ten pairs.
- **Icons (#26, 2026-10-06).** `public/icons/icon.svg` is the one
  source of the Mossgoblin mark: a goblin with a sprout, peeking out of
  a moss mound. `npm run icons` renders the 192, 512 and apple-touch
  PNGs from it; they are committed. The art sits inside the central 80%
  circle, so the 512 PNG doubles as the maskable icon. Browsers that
  take SVG favicons use the SVG.
- Not yet: the textures the spec describes (paper grain, fireflies,
  dithering, the sprite), which ride later polish.

## Editor (2026-10-06)

**Decision.** Notes are edited with CodeMirror 6 in the style of
Obsidian, with two modes over the same text: **live preview** (markdown
syntax hidden except on the line being edited; links, images and
checkboxes drawn as widgets) and **source** (plain markdown). The note
body is one markdown string, stored exactly as typed. Switching modes
only changes the display, so it can never rewrite or lose text.

**Emphasis (Eric, 2026-10-06).** `*text*` is bold and `_text_` is
italic; `**text**` and `__text__` stay bold. Every star means bold,
so `***text***` is bold only; bold italic is `*_text_*`. The grammar reads
single-star emphasis as strong (`grammar/emphasis.ts`), so the editor
and the HTML renderer agree. The stored text is unchanged, so tools
outside Mossgoblin still show `*text*` as italic; the MCP tools (step
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
wrapper that passes text in and out. Things only Mossgoblin needs
(resolving `attachment:` ids, looking up wiki link targets) come in
through small interfaces rather than imports.

**As built (2026-10-06).** `@mossgoblin/editor` exports the grammar on its
own (`@mossgoblin/editor/grammar`: `parseNote`, `renderNoteHtml`,
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

**Ribbon (#77, Eric, 2026-10-07).** On a touch screen the accessory
bar over the keyboard is a formatting ribbon: checklist item, bold and
italic (`*bold*`, `_italic_`, toggled around the selection or as a pair
around the cursor), link (`[[`), bulleted and numbered list (numbered
down the selection; again on a list of that kind makes plain lines),
outdent and indent (two spaces, a list level; indent only list items,
since four spaces would make plain text a code block), and Done (hides
the keyboard). The row scrolls sideways when a phone is too narrow,
with Done pinned at its end. Each is
one transaction, undone in one step, and a marker put in where the
cursor is lands before what is typed next. Taps act a frame later, so
an Enter or Backspace CodeMirror is still holding back on Android lands
first. Insert image is the last action (#44, below). Desktop keys: Mod-b,
Mod-i, Mod-] and Mod-[, which always take the key (Mod-[ is the
browser's Back).

**Finding the keyboard (2026-10-07).** The viewport meta asks for
`interactive-widget=overlays-content`, so on Android Chrome the
keyboard is drawn over the page and neither viewport shrinks; the
ribbon never showed on Eric's phone while it watched `visualViewport`
alone. The bar now reads `navigator.virtualKeyboard` (setting
`overlaysContent` so Chromium reports geometry) and still reads the
visual viewport, which is how Safari shows its keyboard. The ribbon
journey fakes the Android way, so it proves the bar follows the API as
modelled, not that Android reports it so: unverified on a device until
Eric checks his phone (the ribbon shows on focus, hides on the back
button, follows New). Browsers that resize the layout viewport
themselves (Firefox Android) give neither signal and get no ribbon;
not a regression, and left until one of them is in use.

**Desktop toolbar (Eric, 2026-10-07).** With a mouse there is no
keyboard to ride on, so the same actions (less Done) sit in a toolbar
over the note; each button's tooltip names its key. Buttons keep focus
in the note (mousedown is prevented, and a keyboard click returns
focus), so typing carries on where it was.

**Photos (#44, 2026-10-08).** Insert image (ribbon and toolbar) opens
the device's picker, which offers the camera on a phone; it runs on the
tap itself, since a picker needs the tap's user activation. A chosen
photo (JPEG, PNG, WebP, GIF or HEIC, up to 25 MB) is kept on the device
first, in an IndexedDB queue, then its `attachments` record is written
through Firestore's offline cache, and `![name](attachment:<id>)` goes
in on its own line, the cursor below it. The queue uploads to
`users/{uid}/attachments/{id}/{name}` when the device is online and
signed in (on sign-in, on the `online` event, after each attach), and
the note says how many photos are waiting. Until then the editor shows
the device's copy; after, a copy downloaded with the owner's
credentials (a failed download is retried after 30 seconds). A tap on
a photo opens it full screen (a native `dialog`). Photos are only ever
shown as `img`.

**PDFs (#45, part 1, 2026-10-08).** Attach PDF (ribbon and toolbar)
opens a picker for PDFs only, so the photo picker keeps offering the
camera. A PDF goes through the same checks and queue as a photo (its
bytes must be a PDF; its record's kind is `pdf`) and into the note as
`[name.pdf](attachment:<id>)`, a link, which live preview draws as a
chip; `attachmentIds` counts these links too. A tap opens a document
viewer: the device's copy or a download, drawn page by page into
canvases by pdf.js (first 50 pages), with Save for the file itself.
pdf.js and its worker are a lazy chunk, loaded when a PDF is first
opened; the service worker prefetches them with the rest of the app,
so a PDF on the device opens offline. Pages are laid out at once but
drawn only on screen or within a screen of it, and cleared when they
scroll further away, so a phone holds a few pages' pixels, not fifty
(review on #94). Owed: the pages are canvases, so a screen reader gets
"Page n" and no text, and text cannot be selected or found; Save is the
way out until pdf.js's text layer joins, with find-in-PDF below.

**PDF text (Eric, 2026-10-08).** Searching every PDF's text is
server-only: the text is extracted on upload and kept where only the
server and Claude's search read it, never synced to devices, since
many PDFs' text on every device would be large. Searching within one
PDF happens on the device, while it is open in the viewer, from the
text pdf.js reads anyway.

**On the server (#44, 2026-10-08).** A browser labels a file by its
name, so a WebP saved as `.jpg` arrives as a JPEG. The app reads each
photo's first bytes before keeping it (`sniffType`, shared with the
server): it keeps the photo under the type its bytes are, and turns
away anything that is not a photo, saying so, before it enters the
note. `attachmentUploaded`, a Storage trigger, reads each new file's
first bytes too, since the rules can only check the label (review on
#43): bytes that are none of the kept types (HTML, SVG) are deleted
with the attachment's record; bytes of another kept type than the
label are relabelled, not deleted (review on #91). A photo then gets a
WebP thumbnail, at most 640 px, turned upright, beside it as
`thumb_<name>.webp` (the owner-read rule covers it), marked by object
metadata only the function sets, and its record gets `thumbPath`. The
app's names never start `thumb_`. The record write is a merge, and so
is the app's, so a thumbnail made before the phone's record lands is
kept; a record the phone never completes stays holding only
`thumbPath` and `updatedAt`, a shape no rule would accept from the
app, which readers ignore. HEIC, which the image library cannot
decode, keeps no thumbnail. `attachmentDeleted` removes an
attachment's files when its record is deleted. A Storage trigger
runs in its bucket's region, so `attachmentUploaded` deploys to
`STORAGE_REGION` (a deploy variable, default us-central1; Eric's
bucket is us-east1) while the other functions stay in us-central1;
the deploy keeps an image clean-up policy in each (2026-10-08, after
the first deploy refused a us-central1 trigger on a us-east1 bucket).
Inline, the app draws a photo's thumbnail when it has one, and the
viewer swaps in the full photo, downloaded when first opened; a device
still holding its own copy shows that, full size, both ways
(2026-10-08).

**Room above the keyboard (2026-10-07).** The keyboard and the ribbon
overlay the page, so in a long note the ribbon sat on the line being
typed. The bar tells the editor where the cover starts
(`setCoveredFrom`); the editor pads its scroller by as much of its
visible box as is covered, so the last line can scroll clear, and adds
that as a bottom scroll margin, so the cursor stays above the ribbon.
Like the ribbon itself, this is checked against a faked keyboard; on
a device it is unverified until Eric types in a long note (and pinch
zooms) with the ribbon up.

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

Other functions: `noteHistory`, `noteTitle` and `reminderScheduled`
(Firestore triggers), `reminderWake` (a Cloud Tasks queue) and
`sendDuePush` (hourly).

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

The owner uid is a function parameter (`OWNER_UID`, a GitHub
variable; Deploy configuration); any other account is refused. MVP tools:

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

**As built (2026-10-06).**

- **Routes.** `infra/worker/src/routes.json` maps paths to functions
  for the Worker and for the e2e static server alike: `/mcp` to `mcp`;
  the two `/.well-known/oauth-*` documents and `/oauth/register`,
  `/oauth/token`, `/oauth/approve` and `/oauth/revoke` to `oauth`.
  `/oauth/authorize` is the app's consent page; the service worker
  leaves `/oauth/` to the network, so it always comes from the deployed
  version (an older cached app sent claude.ai's first sign-in to the
  home screen, 2026-10-06). Any path a version has no route for checks
  for a newer version and reloads into it before going home. The issuer and every
  endpoint are named from the forwarded host, so no domain is
  configured.
- **Registration** accepts public clients whose redirect URIs are on
  `https://claude.ai` or `https://claude.com` only, so a stranger
  cannot register a client that sends codes elsewhere.
- **Consent.** The page asks the oauth function who is asking (client
  name, return origin), then on Allow posts the request with Eric's
  Firebase ID token. The function verifies the token and refuses any
  uid but `OWNER_UID`; without `OWNER_UID`, nobody can connect.
- **Codes and tokens** are 32 random bytes, stored only as SHA-256
  hashes under `oauth/` (denied to clients by the rules). Codes live
  five minutes and work once, with PKCE S256 required; a `resource`, if
  sent, must be this server's `/mcp`. Access tokens live an hour;
  refresh tokens 90 days, rotating on every use. Everything from one
  approval is a family: a refresh deletes the family's old access
  token, and a replayed code or refresh token (spent ones are kept a
  day to spot this) revokes the whole family. Expired codes and tokens
  are swept whenever tokens are issued, so a connection that refreshes
  hourly stays a few dozen documents. Settings, Disconnect Claude,
  deletes every token and code, in chunks under the 500-write batch
  limit, and claude.ai must connect again.
- **Registration is open** (dynamic registration needs it), but codes
  only ever go to a claude.ai or claude.com callback, and only Eric
  can approve. The consent page shows the name a client registered
  with, which anyone can choose, so it also says to allow only a
  request he just started.
- **MCP** is stateless Streamable HTTP (POST only, JSON responses): each
  request checks the bearer token belongs to the owner, then builds a
  server with the tools. Writes are validated against the zod
  contract before they land; Claude's note writes carry `updatedBy:
  claude` and `deviceId: claude`, so History keeps the version Claude
  replaced. Claude cannot change a title Eric set, and there is no
  delete tool (archive instead). The server's instructions repeat the
  verbatim rule, the emphasis convention (`*bold*`, `_italic_`) and
  that times are ISO 8601 with an offset.
- **Testing.** The e2e suite runs the whole flow against the emulators:
  register, consent, code, token, `tools/call create_note`, the note in
  the app, then Disconnect. Its owner has a fixed uid that `e2e.sh`
  gives the functions emulator as `OWNER_UID` (`.env.local`, written
  for the run and deleted after).

**Organize tools and What Claude changed (#34, 2026-10-07).** Seven
more tools, replacing the Phase 2 list above (`add_synonym` became
`refile`; `record_activity` is not a tool, since every write records
itself; `import_url` waits for M4):

| Tool | Does |
| --- | --- |
| `list_concepts` | Concepts with type, other names and link counts |
| `get_backlinks` | Notes linking here, each with its sentence |
| `link_notes` | Adds a `See also [[...]]` line at the end of a note |
| `split_note` | Cuts a note into pieces, refusing any rewording |
| `merge_notes` | Joins notes into a new one, archiving the originals |
| `refile` | Concept type and other names; tags on any note |
| `archive_note` | Archives or restores |
| `create_concept` | A new person, project or other concept, with the id the app gives a `[[name]]`; refused if a name is taken (Eric, 2026-10-08: his projects list) |

- **Verbatim, by construction.** `split_note` takes the parts as text
  and accepts them only if they are the note itself, in order, cut
  where there is whitespace (`mcp/verbatim.ts`); the first part stays
  in the note, which links the new ones. `merge_notes` joins whole
  bodies with a blank line between. Claude's own words are only the
  `See also` and `Split off:` lines.
- **Links follow a merge.** The merged note answers to its originals'
  titles as synonyms, and `nameIndex` now indexes the synonyms of any
  note, after every title, so `[[Old title]]` elsewhere reaches the
  merged note instead of making a stub. The originals are archived
  with `mergedInto`; the merged note keeps the earliest `createdAt`.
  An original linking another stores no link to the merged note
  itself. Caveat: an edit made offline to an original, synced after
  the merge, lands in the archived original (and its History), not in
  the merged note; it shows only under Archived.
- **Activity.** Every write tool (the MVP ones too) records a run in
  `users/{uid}/activity` in the same batch or transaction as the
  change: tool, a one-line summary, and the notes and reminders it
  touched, named as they were (`Activity` in the schema). The uid is
  the token's, as for every tool. Runs are function-only; the rules
  already let the owner read them and nobody write them.
- **What Claude changed** (`/activity`, linked from Browse and from
  Settings, Claude) lists the latest 100 runs, newest first, each
  with its notes (current titles, archived ones marked), each note's
  History, and its reminders. Older runs stay stored.

**Nightly suggestions (#35, 2026-10-07; a Claude routine, Eric,
2026-10-07).** A Claude routine on Eric's subscription, not a
scheduled function calling the API: billing comes from his plan. The
prompt is `routines/nightly-suggestions.md`; Eric installs it himself
in claude.ai with the Mossgoblin connector. It reads through the MCP
tools and writes only through `suggest_changes`.

- **`suggest_changes`** takes link, merge and refile suggestions, each
  with a sentence of reason, and stores the ones that check out in
  `users/{uid}/proposals` as open. It changes no notes and records no
  activity; that comes when a suggestion is accepted.
- **Checked before stored** (`organize/proposals.ts`): the notes must
  exist and be live; a link must be new and reach its note by name; a
  merge takes two or more text notes; a refile must change something
  and not take a name another note answers to. A suggestion made
  before, in any state, is not made again (its `key`). At most 10 per
  call and 20 waiting; the answer says what was stored and dropped.
- **Accept or dismiss.** Under What Claude changed, each suggestion
  says what it would do, why, and offers Accept and Dismiss; Browse's
  link counts the open ones. The app may only move an open proposal
  to accepted or dismissed (rules), through the persistent cache, so
  this works offline. `proposalAccepted` then claims it (applying,
  stamped `claimedAt`, so a retry cannot run it twice), runs the
  matching organize tool (`link_notes`, `merge_notes`, `refile`),
  which records itself in What Claude changed, and stores the outcome:
  applied, or failed with why (the garden moved on). A failure stays
  in view for three days.
- **Housekeeping**, at each `suggest_changes`: a claim older than an
  hour is marked failed (its function stopped partway), and applied
  and failed proposals are deleted after 90 days. Dismissed ones stay,
  so a dismissed suggestion never returns; the read of them is keys
  only. A stuck claim therefore shows as in progress until the next
  routine run, or until the routine is turned back on.
- **Note text is data.** The routine's prompt says so; the server's
  checks, the accept gate and the tools' own checks bound what a
  steered suggestion could do.
- **The write ban is the prompt's.** The routine holds the whole
  connector, so only its prompt keeps it to `suggest_changes`. Any
  other write would still be recorded under What Claude changed and
  could be put back from History, since nothing deletes.

**Safe co-editing (#37, 2026-10-07).** A note save used to replace the
whole body, last write winning. Now nothing either side writes is lost
when Eric and Claude (or two devices) edit one note at once:

- **Claude edits lines, not bodies.** `add_lines` (under a heading,
  matched without case, after its last line of text; a missing heading
  is added at the end), `check_item` and `uncheck_item` (by item text,
  exact or the only one containing it) run in a transaction against
  the current text and change only the lines they name. The server
  instructions and `add_lines` steer Claude to them over `update_note`
  for lists. Each records itself in What Claude changed.
- **The open editor merges.** The capture loop keeps `synced`, the text
  the server last had from this device's view (loaded, saved or merged
  in). A snapshot with other text is merged with what was typed since
  (`merge3`, schema: a line-based three-way merge that keeps both sides
  where they overlap, and keeps an item added beside an edited line
  without repeating it), shown in place with the cursor where it was
  (`updateText`), and saved if typing survived. The editor merges once
  more against keys typed before it heard of the change.
- **Its own saves are not news (2026-10-07).** The capture loop
  remembers the texts it saved for the open note (the last 50). A
  snapshot carrying one of them, written by this device, is a late echo
  of its own write and is ignored: merged as someone else's edit, it
  undid Eric's edit since, the save built on it crossed the newer text,
  and with no shared text found the server kept both, so two lines
  showed before and after his fix. The same text from another device,
  Claude or a merge is a real change (a laptop unticking an item) and
  merges in.
- **Writes say what they were written over.** Each body write carries
  `baseHash`, the `textHash` of the text it replaced as the writer had
  it ('' when not known, e.g. a draft from before sign-in). When
  `noteHistory` sees a write whose base is not the text it replaced (a
  phone coming back online with a queued tick, or a save crossing
  Claude's edit), it finds the shared text among the last 20 texts
  writes replaced (server-only, `notes/{id}/replaced/{hash}`, one
  document each in write order, kept by `noteHistory` on every change,
  texts over 300,000 characters skipped, each removed after 2 days by
  a TTL policy on `expireAt` so a deleted note's texts do not stay;
  2026-10-07; changed the same day from 20 kept, trimmed on each save,
  and 30 days: saves arriving together trimmed by the counts they saw
  and deleted the newest texts too. Within the 2 days they are not
  capped: every distinct text a note passes through stays, one write
  each; an older base falls back to History) and the last 20 kept
  versions, merges,
  and writes the result as device `merge` in a transaction. The two
  writes can start from different texts (two devices, one of them
  saving twice); the older one, which both descend from, is the base.
  If the note was saved again since by a write built on the merged one
  (the same device's next save, a write made straight over it, or
  Claude's), the merge is carried onto that write instead of dropped;
  a third writer that had not seen it is merged in from the shared
  text too. With no shared text kept, both are merged as if they had
  none in common: every line of both stays, though an edited line can
  show in both versions and a deleted one come back.
- **Limits.** A merge keeps both versions of a line both sides changed
  differently, which can read as a near-duplicate. A rewrite too large
  to compare line by line (`MAX_TABLE` cells) keeps both sides of the
  changed middle. Stored `links` on a
  server merge are not recomputed until the next edit (readers derive
  links from bodies). Keystrokes never wait on any of this.

## Push

The app registers an FCM token per device in `devices`. `sendDue`
finds reminders with `nextFireAt <= now`, sends one web push each, and
advances `nextFireAt` (next occurrence for recurring reminders, cleared
otherwise). A Cloud Task wakes it when a push falls due, and
`sendDuePush` runs it hourly as a safety net (2026-10-07; it ran every
minute, 1,440 times a day). Tapping a notification opens the
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
- **Waking (Eric, 2026-10-07).** Every write that sets or moves a
  reminder's `nextFireAt` (made, snoozed, edited, or advanced by a
  claim) queues a Cloud Task for that moment (`reminderScheduled`),
  named by reminder and time so the same write never queues twice. The
  task (`reminderWake`, three tries) runs `sendDue`; its claim already
  makes any run safe, so a stale or duplicate wake sends nothing. A
  task reaches 30 days ahead, so a later push hops: the wake re-queues
  toward it, at times counted back from the push in 29-day steps so
  every caller names a hop alike. The hourly `sendDuePush` also queues wakes for pushes in
  the next 65 minutes, which covers a lost task and reminders set
  before tasks existed. The e2e suite runs no tasks emulator (a
  dispatched task would claim reminders mid-journey), so queueing is a
  no-op under the functions emulator; unit specs cover it.
- **Sending.** `sendDue` (no retries in the hourly run) reads up to
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

## Deploy configuration (Eric, 2026-10-06)

Nothing specific to one deployment is committed, so a fork runs its
own copy by setting variables, not by editing code. GitHub repository
variables and secrets feed `.github/workflows/deploy.yml`, which hands
them to `scripts/deploy.sh`:

- The web build gets `FIREBASE_WEB_CONFIG` and `WEB_PUSH_PUBLIC_KEY`
  through `ng build --define`; local and e2e builds leave them null,
  and localhost always uses the emulators.
- Functions get `OWNER_UID` and the `ANTHROPIC_*` federation ids from
  a `.env.<project>` file the script writes for the deploy and deletes.
- The Worker gets its custom domain from `APP_DOMAIN` (`--domain`) and
  `FUNCTIONS_ORIGIN` from `FIREBASE_PROJECT_ID`.

The deploy fails before building when a required variable is missing
or the web config names another project. Optional ones leave their
feature off (no push key: notifications are not set up; no federation
ids: first-words titles). The full list is in README.md, Run your own.
Values committed before this change remain in git history; none is a
secret.

**Rename to Mossgoblin (#25, 2026-10-06).** The app, the MCP server,
the npm scope (`@mossgoblin/*`), the editor's CSS prefix (`--mg-*`,
`.mg-*`), the emulator project (`demo-mossgoblin`) and the Worker
(`mossgoblin`) took the new name. Run without a terminal, `wrangler
deploy` moves the custom domain from the old Worker to the new one,
and the first deploy after the rename (2026-10-06) deleted the old
`goblin-mode` Worker; that one-time step is gone from
`scripts/deploy.sh`.
Kept on purpose: the GitHub repo name (Eric, 2026-10-06), the Firebase
project, Firestore paths, the connector URL, the `goblin-titles`
service account (renaming it means new IAM grants), and the
device-local `goblin.*` keys, so no pending draft is stranded; M5
re-keys those by uid (#53).

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
`oauth/`, is denied. Storage allows only the owner's attachment files
at `users/{uid}/attachments/{id}/{name}`, up to 25 MB and of the image
and PDF types the schema lists; the client writes them and their
`attachments` record directly, so a photo taken offline is kept
offline. Everything else in Storage is denied (#43, 2026-10-07).
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
Actions at all. Mossgoblin adds one workflow, `deploy.yml`, that runs
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
6. History and titles: `noteHistory`, `noteTitle` (Claude through
   workload identity federation, set up 2026-10-06). Built 2026-10-06;
   titles come on settle.
7. MCP: OAuth, tools, connector set up in claude.ai. Built 2026-10-06;
   the connector is added in claude.ai by Eric (QUESTIONS.md).

First deploy to mossgoblin.garden: done 2026-10-06.
