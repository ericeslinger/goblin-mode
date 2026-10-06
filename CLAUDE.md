# Goblin Mode

A single-user, offline-first notes PWA at mossgoblin.garden, with Claude
as an editor through MCP. Built on the Angular + Firebase + Cloudflare
stack playbook and the `house-style` plugin (enabled in
`.claude/settings.json`); this file outranks both.

## Read this first

| Document | What it is for |
| --- | --- |
| README.md | Running it locally |
| DESIGN.md | The technical design and build order; decisions dated in place |
| QUESTIONS.md | Open questions and setup Eric still owes; read before proposing architecture |
| UX spec (Claude Docs, "Goblin Mode UX Spec") | Product and UX: screens, flows, MVP cut |
| Working notes (Claude Docs, "Goblin Mode Working Notes") | Eric's requirements and the Decisions table |

## Invariants

- **No backend switch.** localhost is always the emulator suite, auth
  included; anywhere else is always the real project
  (`packages/frontend/src/app/firebase.ts`). A switch permits two silent
  mistakes: writing to production from a dev server, and a deployed page
  waiting on an emulator.
- **Owner-only data.** Everything lives under `users/{uid}` and the rules
  allow only that uid. `oauth/` is server-only. A rules change needs a
  rules test in `packages/rules-tests`. The `isValid*` shape
  validators in `firestore.rules` are generated from the zod schemas:
  change the schema and run `npm run rules:gen`, never edit them by
  hand.
- **Never lose a keystroke.** Note writes go through the Firestore
  persistent cache, never a network-only path, and nothing in the
  capture flow waits on the network or on auth before accepting input.
- **Claude never rewrites Eric's paragraphs unbidden.** MCP tools may
  create, link, split, merge, re-file and archive, but must keep his
  text verbatim. Merges archive originals instead of deleting them.
- **Emulator-only code stays out of production bundles.** It never gets
  imported from `packages/functions/src/index.ts`; the functions dry
  run fails if the marker `EMULATOR_ONLY` reaches the bundle.
- **The functions package declares no devDependencies.** The deploy runs
  `npm install --omit=dev` there and npm crashes on devDependency peers
  (`reading 'edgesOut'`). Build tools go in the root package.json.
- **No deployment in the code.** Code and config files name no
  deployment: project ids, the web config, domains, uids and federation
  ids are GitHub variables passed in by `scripts/deploy.sh` (README, Run
  your own), so a fork deploys by setting variables. Prose may describe
  Eric's deployment; values committed before 2026-10-06 remain in git
  history.
- **Ids are derived or generated client-side**, never typed by hand, so
  a note exists the moment it is created offline.

## Prose

Hard-wrap at about 75 columns. No em-dashes. Decisions are dated in
place and never silently re-litigated; to change one, say so and date
the change. No model identifiers or tooling banners in commits, PR
bodies or code comments.

## Gates

There is no CI (2026-10-05). The only GitHub workflow is `deploy.yml`,
which deploys `main` after merge; there are not enough Actions minutes
for anything else.

- `npm run gate` must pass before every commit: typechecks (spec files
  included), `prettier --check`, the rules-validator drift check
  (`npm run rules:gen -- --check`), the frontend build, unit tests (vitest
  for schema, editor, functions and worker; `ng test` for the frontend), the
  functions deploy dry run (staged `npm install --omit=dev` and import),
  and the Worker deploy dry run. No ESLint (house style).
- `npm run e2e` must pass before pushing or opening a PR: it builds the
  e2e configuration, starts the e2e emulator suite (ports 9199, 8180,
  5101, 9198), serves the app on :4300, runs the rules tests
  (`packages/rules-tests`) and the Playwright journeys (including the axe
  accessibility journey), and tears everything down.
- Prose-only changes skip both. A new test suite is wired into a gate in
  the same change. A new user flow gets a journey in the same PR.

## Where this repo differs from house style

Dated, and deliberate; everything else follows the plugin.

- **Hosting is a Cloudflare Worker**, not Firebase Hosting, and the
  backend package is `packages/functions` (stack playbook, 2026-10-04).
- **No CI** (2026-10-05). Rules tests need the emulator, so they run in
  `npm run e2e` rather than in a CI job.

## PRs, review and merging

1. **Branch and gate.** Work on a branch; `npm run gate` green before
   each commit.
2. **Open the PR** after `npm run e2e` is green. The body states which
   gates ran, their results, and the head sha they ran on.
3. **Spawn the review agent** (`.claude/agents/pr-review.md`) with the PR
   number and wait for its summary comment.
4. **Answer every comment.** Fix and push, or reply why not. Re-run both
   gates after any push, then ask the same agent to re-review.
5. **Merge** with a merge commit only when all hold: the latest summary
   says approved; every comment is answered; gate and e2e are green on
   the exact head after the last push; main has not moved since; and the
   change has no schema change or data migration. If main moved, merge
   it in and go back to 4.
6. **Delete the merged branch** on origin and locally, then **start
   fresh from main** for the next change. Never stack new work on a
   merged branch, and never delete a branch with unmerged commits.

This is the house-style rule (Eric, 2026-10-05), hardened here: also
wait for Eric, with a PR comment saying why, when the change touches
`packages/schema`'s stored-document schemas, `firestore.rules` or
`storage.rules`, a data migration, auth, the merge policy itself, or
the reviewer flags it for Eric to read.

## Cloud sessions

`.claude/hooks/session-start.sh` runs only when
`CLAUDE_CODE_REMOTE=true`. It installs Node 22.22.3 (the container's
22.22.0 is below the Angular CLI minimum), trusts the agent proxy CA
through `NODE_EXTRA_CA_CERTS`, runs `npm ci`, and links the
preinstalled Chromium under the revision Playwright expects. Never run
`playwright install`, and do not run a second `npm ci` while the hook
is still running. Do not `pkill -f` on broad patterns: it can match and
kill your own shell.

Journeys never drive the Google sign-in popup: `apis.google.com` is
blocked. They sign in by email and password at `/dev-sign-in`, which
only works against the emulator. `prepPage` aborts off-box requests;
it must abort, not stub, because Firebase Auth hangs on an empty
`apis.google.com` response.
