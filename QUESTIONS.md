# Open questions

Answered ones move into DESIGN.md with their date.

## Setup Eric owes before the first deploy

1. **Firebase project.** Create one (Blaze plan, for Functions and
   scheduled jobs), enable Google sign-in, Firestore with point-in-time
   recovery, and Storage. Then:
   - paste its web config into
     `packages/frontend/src/environments/firebase-config.ts`
     (`PRODUCTION_FIREBASE_CONFIG`; it is not secret);
   - set the repository variable `FIREBASE_PROJECT_ID`;
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

- **Who can sign in.** The rules confine each user to their own
  `users/{uid}`, so a stranger signing in with Google sees an empty app
  and cannot read Eric's data. Blocking other accounts entirely needs
  an Identity Platform blocking function; worth it?
- **Region.** Functions default to `us-central1`. Move closer if latency
  to the MCP endpoint matters.
