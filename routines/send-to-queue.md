# Send to an assistant routine

The routine that works through the notes Eric sends from the app
(#143). A note's back has Send to an assistant, with an optional ask;
the note then waits in the queue until this routine runs. It runs on
Eric's own subscription with the Mossgoblin connector, so Mossgoblin
holds no key and pays nothing for it.

## Setting it up

1. Make sure the Mossgoblin connector is added in claude.ai (README,
   Run your own, "To connect Claude") and works in a chat.
2. Create a routine in Claude Code on the web that runs every hour,
   with the Mossgoblin connector enabled. It needs no repository and
   no other connector.
3. Paste the prompt from Settings, AI assistants, Send to an
   assistant (`QUEUE_PROMPT` in `packages/schema/src/queue.ts`).
4. Send a note, run the routine once by hand, and check the note's
   back says Done, and What assistants changed shows what it did.

A note waits up to one interval: the app cannot wake the routine. Any
other assistant that can run on a schedule with an MCP server can use
the same prompt.

## Safety

The routine holds the whole connector, and a sent note may hold text
from the web (a saved page, an imported recipe). The prompt says only
Eric's ask is an instruction, and the tools label web text `fromWeb`
(CLAUDE.md, page text). Everything it does shows under What assistants
changed, and the tools archive instead of deleting, so History can put
a note back.
