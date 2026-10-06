# Open questions

Answered ones move into DESIGN.md with their date.

## Setup Eric owes

Done 2026-10-05/06: the Firebase project `mossgoblin-garden` (Blaze,
point-in-time recovery, weekly backups, sign-up disabled, owner account
created by hand), the deploy service account, the Cloudflare token, and
the GitHub secrets and variables. The first deploy succeeded on
2026-10-06.

Still owed:

1. **Anthropic API key** for titles: a Functions secret
   `ANTHROPIC_API_KEY` (`firebase functions:secrets:set`). Needed at
   build order step 6, not before.

## Product

- **People and project fields** (2026-10-05: left open on purpose). They
  extend the base note schema once real use shows what is needed.
- **Feelings template.** Designed together once journaling is in use.

## Editor

Open from the 2026-10-06 editor decision (DESIGN.md, Editor):

- **Default mode on the phone.** Live preview, with source one tap
  away? Remembered per note or app-wide?
- **GFM task lists** (`- [ ]`). goblin turned GFM off only because of its
  75-column re-wrap, which Goblin Mode does not do.
- **Directives on day one?** goblin's `:::aside` and `::embed{#id}`
  syntax, or later when a first custom block is needed.
- **Bundle cost.** CodeMirror plus remark adds roughly 150 to 250 kB to
  the first load (estimate, not measured); the service worker caches it
  after that. Measure before building, or accept?

## Technical

- **Google sign-in for the hand-made account.** Sign-up is disabled
  and the owner account was created in the console. Confirm that
  "Sign in with Google" on mossgoblin.garden signs into that same uid
  (it should when the emails match) rather than being refused as a new
  account.
- **Region.** Functions default to `us-central1`. Move closer if latency
  to the MCP endpoint matters.
