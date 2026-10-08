---
name: garden-this
description: File a session's decisions, ideas and open questions to Eric's Mossgoblin project page, through the Mossgoblin Garden connector's capture tool. Use when Eric says "garden this", and offer it at the end of a working session.
---

# Garden this (#42)

Mossgoblin is Eric's notes app. Each project is a concept with
sections: Overview, Working notes, Tasks, Ideas, Open questions,
Decisions, Links. The `capture` tool (Mossgoblin Garden connector)
files words under a project, keeping them word for word.

## When

- Eric says "garden this", or asks to file something to a project.
- At the end of a working session: offer once, in one line, to garden
  the decisions and ideas from it. File nothing without a yes.

## How

1. Find the project: `list_concepts` with type `project`. For this
   repository it is `mossgoblin`. Ask if it is not clear.
2. Pick what to file, and show Eric the list before filing:
   - **decision**: something settled, in the words it was settled in.
   - **idea**: something worth keeping that was not acted on. Give it
     a one-line `summary`, which is yours and marked as Claude's.
   - **question**: something still open.
   - "remind me" becomes `remind` on the item it belongs to.
3. Call `capture` once per item, with `timeZone` set to Eric's zone
   (ask if you do not know it) and `source` set to the PR or session
   link when there is one.
4. Say what was filed, one line each.

## Rules

- Eric's words go in verbatim. Your summary goes in `summary` only,
  never in place of his text.
- Quote decisions as they were made. Do not merge or reword them.
- Never file secrets, tokens or anything from `.env` files.
