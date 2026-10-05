# Goblin Mode

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

## Checks

```
npm run gate   # before every commit
npm run e2e    # before every PR
```

## Layout

```
packages/shared     types and pure logic
packages/frontend   Angular PWA
packages/functions  Cloud Functions
packages/e2e        Playwright journeys and rules tests
infra/worker        Cloudflare Worker (static assets + proxy)
scripts/            gate, e2e, deploy
```
