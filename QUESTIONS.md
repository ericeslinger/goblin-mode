# Open questions

Answered ones move into DESIGN.md with their date.

## Setup Eric owes before the first deploy

1. **Firebase project** `mossgoblin-garden` (created 2026-10-05; its web
   config is in `packages/frontend/src/environments/firebase-config.ts`,
   `.firebaserc` alias `prod`). Still to check or do: Blaze plan, Google
   sign-in enabled, Firestore with point-in-time recovery, Storage. Then:
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

- **Who can sign in. Decide before the first production deploy.** The
  rules confine each user to their own `users/{uid}`, so a stranger
  signing in with Google cannot read Eric's data, but can still write
  notes into their own space on Eric's Blaze project, which costs money.
  Options: an owner-uid check in the rules once the uid is known, or an
  Identity Platform blocking function that refuses other accounts at
  sign-in.
- **Region.** Functions default to `us-central1`. Move closer if latency
  to the MCP endpoint matters.
