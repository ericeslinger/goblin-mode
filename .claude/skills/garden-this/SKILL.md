---
name: garden-this
description: File a session's decisions, ideas and open questions to Eric's Mossgoblin project page, through the Mossgoblin Garden connector's capture tool. Use when Eric says "garden this", and offer it at the end of a working session.
---

# Garden this (#42)

The procedure, the project page shape and the conventions for what
Claude writes live in the Mossgoblin Garden connector's server
instructions (`INSTRUCTIONS` in `packages/functions/src/mcp/server.ts`),
so every Claude chat gets the same ones, with or without this repo.
Follow them; they are not repeated here.

## Repo-side lines

- For this repository the project is `mossgoblin` (`c-mossgoblin`).
- At the end of a working session, offer once, in one line, to garden
  the decisions and ideas from it. File nothing without a yes.
- Set `source` to the PR or session link when there is one.
- Never file secrets, tokens or anything from `.env` files.
