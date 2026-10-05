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
validators generated from the schemas, with a drift check in the gate,
starting with step 2. Claude's MCP writes go through functions and are
parsed against the same schemas.

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
Auth state is restored from IndexedDB; until it resolves, typing goes
into an in-memory draft that is written once the uid is known.

**New or resume.** On `visibilitychange` to hidden, and on `pagehide`,
the app stores the time and the open note id in localStorage. On
visible or cold start, more than 5 minutes since that stamp opens a
fresh note; otherwise the stored note reopens. "Previous note" opens a
short list of recent notes.

**Saving.** Each keystroke updates a signal; a 300 ms debounced write
sends the note to Firestore. With the persistent local cache that write
lands in IndexedDB at once and syncs when online, so there is no Save
button and nothing is lost offline. A note whose body is still empty
when you leave is deleted.

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
two panes from 900 px (list left, note right).

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

The owner uid is a function parameter (`OWNER_UID`); any other account is
refused. MVP tools:

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

## Security

Google sign-in. Firestore rules allow only `request.auth.uid == uid`
under `users/{uid}`, and only for the write path each collection has:
the client writes `notes`, `reminders` and `devices`; `notes/history`
and `activity` are read-only to the client; anything unlisted, and
`oauth/`, is denied. Storage is deny-all until attachments (Phase 2)
decide its write path.
No end-to-end encryption, so MCP and search can read notes (2026-10-05).
Firestore point-in-time recovery is on as the backstop for bad edits.

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
   workflow, an app shell that signs in.
2. Capture: launch screen editor, autosave, offline, new-or-resume,
   Previous note, Recent list and search, two-pane layout; the rules
   shape-validator generator for `notes`.
3. Reminders: Right Now panel and full list, add, done, snooze, recurring.
4. Push: device registration, `sendDuePush`, notification taps.
5. History and titles: `noteHistory`, `noteTitle`.
6. MCP: OAuth, tools, connector set up in claude.ai.
7. First deploy to mossgoblin.garden (can move earlier once secrets exist).
