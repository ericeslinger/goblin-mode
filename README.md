# Mossgoblin

A goblin in the woods who keeps the notes you leave in his garden. A
single-user, offline-first notes PWA with Claude as an editor through
MCP. Lives at mossgoblin.garden.

Start with CLAUDE.md (rules), DESIGN.md (how it is built) and
QUESTIONS.md (what is open).

## Run it locally

Needs Node 22.22.3 or later and Java 21 (for the Firestore emulator).

```
npm ci
npm run emulators            # terminal 1: auth, firestore, functions
npm start -w packages/frontend   # terminal 2: http://localhost:4200
```

On localhost the app always talks to the emulators. Sign in at
`/dev-sign-in` with any email and password you created in the Auth
emulator, or with the Google button (emulated).

## Run your own

Fork the repo, then create a Firebase project (Blaze, for functions),
add a web app to it, and put the domain on Cloudflare. Everything about
your deployment is set as GitHub repository settings (Settings, Secrets
and variables, Actions); nothing in the code names a deployment.

| Name | Kind | Value |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | variable | The Firebase project id |
| `FIREBASE_WEB_CONFIG` | variable | The web app's config as JSON (Project settings, Your apps) |
| `APP_DOMAIN` | variable | The domain to serve, on your Cloudflare account |
| `CLOUDFLARE_ACCOUNT_ID` | variable | Your Cloudflare account id |
| `CLOUDFLARE_API_TOKEN` | secret | Token that can deploy Workers and set custom domains |
| `FIREBASE_SERVICE_ACCOUNT` | secret | JSON key of the deploy service account |
| `WEB_PUSH_PUBLIC_KEY` | variable, optional | Cloud Messaging Web Push public key; notifications |
| `OWNER_UID` | variable, optional | Your Firebase Auth uid; the MCP server's one account |
| `ANTHROPIC_FEDERATION_RULE_ID` | variable, optional | Claude titles (DESIGN.md, Titles) |
| `ANTHROPIC_ORGANIZATION_ID` | variable, optional | Claude titles |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | variable, optional | Claude titles |
| `ANTHROPIC_WORKSPACE_ID` | variable, optional | Only if the federation rule covers several workspaces |

Also create a Google service account named `goblin-titles` in the
project, with `roles/datastore.user`, and let the deploy service
account act as it (`roles/iam.serviceAccountUser` on it): `noteTitle`
always runs as that account, even with titles off. DESIGN.md, Titles,
covers the Claude side.

The deploy account cannot change project IAM, so the first deploy of
the Firestore-triggered functions stops and asks a project owner to
grant, once (with `<number>` your project number):

- `roles/iam.serviceAccountTokenCreator` to
  `service-<number>@gcp-sa-pubsub.iam.gserviceaccount.com`;
- `roles/run.invoker` and `roles/eventarc.eventReceiver` to
  `<number>-compute@developer.gserviceaccount.com` and to
  `goblin-titles@<project>.iam.gserviceaccount.com`.

If the next deploy then reports "Permission denied while using the
Eventarc Service Agent", wait a few minutes and re-run it; if it
persists, grant `roles/eventarc.serviceAgent` to
`service-<number>@gcp-sa-eventarc.iam.gserviceaccount.com`.

Reminder pushes are woken by Cloud Tasks (`reminderWake`). Once,
a project owner enables the Cloud Tasks API, grants the deploy service
account `roles/cloudtasks.queueAdmin` (the deploy creates the queue),
and grants `<number>-compute@developer.gserviceaccount.com`
`roles/cloudtasks.enqueuer` and `roles/iam.serviceAccountUser` on
itself (functions queue wakes as it). Without the API or
`queueAdmin` the deploy fails at the functions step (rules and indexes
already shipped); without the last two it deploys, and pushes still
go, up to an hour late, from the hourly `sendDuePush`.

The photo checker and thumbnailer (`attachmentUploaded`) is a Cloud
Storage trigger. Once, a project owner grants the Cloud Storage service
agent `roles/pubsub.publisher`:

```bash
gcloud projects add-iam-policy-binding <project> \
  --member=serviceAccount:service-<number>@gs-project-accounts.iam.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

Photos (#44) are downloaded by the app with the owner's credentials, so
the Storage bucket must allow your domain. Once, as a project owner,
with `<bucket>` from `gcloud storage buckets list`:

```bash
echo '[{"origin": ["https://<APP_DOMAIN>"], "method": ["GET"], "responseHeader": ["Authorization", "Content-Type"], "maxAgeSeconds": 3600}]' > cors.json
gcloud storage buckets update gs://<bucket> --cors-file=cors.json
```

Without it a photo shows only on the device that took it, until that
device's copy is gone; elsewhere its caption shows instead. To check:
a photo taken on the phone shows in a browser tab on another device.

To connect Claude, add a custom connector in claude.ai with the URL
your app's Settings shows (`https://<APP_DOMAIN>/mcp`); only
`OWNER_UID` can approve it. For nightly suggestions, add the routine
in `routines/nightly-suggestions.md` to your claude.ai account.

A push to `main` deploys. The deploy stops before building when a
required value is missing; an optional one left out turns its feature
off. DESIGN.md, Deploy configuration, has the details.

## Checks

```
npm run gate   # before every commit
npm run e2e    # before every PR
```

## Layout

```
packages/schema       zod contract and pure logic
packages/editor       note grammar and CodeMirror editor (no Angular)
packages/frontend     Angular PWA
packages/functions    Cloud Functions
packages/e2e          Playwright journeys
packages/rules-tests  Firestore rules allow/deny suites
infra/worker          Cloudflare Worker (static assets + proxy)
scripts/              gate, e2e, deploy
```
