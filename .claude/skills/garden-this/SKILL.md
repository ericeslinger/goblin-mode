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
- A project's stages and item tags, and where each item stands, are
  set with `refile` and `update_reminder` (server instructions). Moving
  a pot to its next stage is not gardening: do it when Eric asks,
  not as part of filing a session.
- Eric's Context for Claude (`get_context`, the note with id
  `context`) comes with the server instructions; read it before
  gardening. Add to it only when he asks you to remember something.
- Gardening files under a project, so it needs the Projects module on
  (#126). If `capture` says Projects is switched off, tell Eric, and
  file nothing.
- A recipe is not gardened: when Eric gives one, make it with
  `create_recipe` (Kitchen on), not `capture`; for a link, use
  `import_recipe` and never read the page yourself. Meals go on the
  plan with `plan_meal`, how one went with `log_meal`, and what Eric
  has on hand with `update_pantry`, not `capture`.
