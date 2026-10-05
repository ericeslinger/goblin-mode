# Open questions

Answered ones move into DESIGN.md with their date.

## Setup Eric owes before the first deploy

1. **Firebase project** `mossgoblin-garden` (created 2026-10-05; its web
   config is in `packages/frontend/src/environments/firebase-config.ts`,
   `.firebaserc` alias `prod`). Done by Eric (2026-10-05): Blaze plan,
   point-in-time recovery, weekly Firestore backups. Still to check or
   do: Google sign-in enabled, Firestore and Storage created in
   `us-central1`. Then:
   - set the repository variable `FIREBASE_PROJECT_ID` to
     `mossgoblin-garden`;
   - add the repository secret `FIREBASE_SERVICE_ACCOUNT` (a service
     account JSON key with Firebase Admin, Cloud Functions Admin, Service
     Account User and Cloud Scheduler Admin);
   - add `mossgoblin.garden` to Auth's authorized domains.
2. **Cloudflare.** Repository secret `CLOUDFLARE_API_TOKEN` (Workers
   Scripts edit, Workers Routes edit, and DNS edit for
   mossgoblin.garden) and repository variable `CLOUDFLARE_ACCOUNT_ID`.
3. **Anthropic API key** for titles: a Functions secret
   `ANTHROPIC_API_KEY` (`firebase functions:secrets:set`). Needed at
   build order step 5, not before.

## Product

- **People and project fields** (2026-10-05: left open on purpose). They
  extend the base note schema once real use shows what is needed.
- **Feelings template.** Designed together once journaling is in use.

## Technical

- **Google sign-in for the hand-made account.** Sign-up is disabled
  and the owner account was created in the console. Confirm that
  "Sign in with Google" on mossgoblin.garden signs into that same uid
  (it should when the emails match) rather than being refused as a new
  account.
- **Region.** Functions default to `us-central1`. Move closer if latency
  to the MCP endpoint matters.
