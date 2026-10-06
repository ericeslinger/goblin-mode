# Open questions

Answered ones move into DESIGN.md with their date.

## Setup Eric owes

Done 2026-10-05/06: the Firebase project `mossgoblin-garden` (Blaze,
point-in-time recovery, weekly backups, sign-up disabled, owner account
created by hand), the deploy service account, the Cloudflare token, and
the GitHub secrets and variables. The first deploy succeeded on
2026-10-06. The Web Push key pair was generated on 2026-10-06; its
public key is in `firebase-config.ts`. Claude access for titles by
workload identity federation was set up and tested on 2026-10-06 (a
token exchange from `goblin-titles` succeeded); its ids are GitHub
variables (README.md, Run your own).

Also done 2026-10-06: the GitHub variables for deploy configuration
(PR #13), and the Cloud Scheduler API (the first `sendDuePush` deploy
enabled it). Nothing is owed right now.

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
- **Remote images in notes.** A note can show an http(s) image from
  any host, which means opening the note fetches it (and tells that
  host). Keep, or limit images to attachments? Until decided, they
  load (raised in review of PR #6, 2026-10-06).
- **Region.** Functions default to `us-central1`. Move closer if latency
  to the MCP endpoint matters.
