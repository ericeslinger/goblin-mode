import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type NotesTools, ToolError } from './tools';

/** What every Claude conversation using the connector is told. */
export const INSTRUCTIONS = [
  "Goblin Mode is Eric's notes app: quick notes, and reminders shown in Right Now.",
  "Keep Eric's paragraphs word for word. You may add your own text, re-file, tag, link, " +
    'split, merge and archive, but never reword what he wrote unless he asks you to.',
  'Prefer archiving to deleting; there is no delete tool.',
  "In Eric's notes *single stars* mean bold and _underscores_ mean italic; " +
    'write emphasis the same way.',
  'Times are ISO 8601 with an offset. Ask Eric for his time zone if you need one and do not know it.',
].join('\n');

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

/** Runs a tool; a ToolError or a contract violation goes back to Claude. */
function run<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return text(await fn(args));
    } catch (err) {
      if (err instanceof ToolError || err instanceof z.ZodError) {
        return { isError: true, content: [{ type: 'text' as const, text: err.message }] };
      }
      throw err;
    }
  };
}

const read = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const time = z.string().describe('ISO 8601 with an offset, e.g. 2026-10-07T21:00:00-07:00');

/** The tools as the server calls them: any result goes back as JSON. */
export type ToolsApi = {
  [K in keyof NotesTools]: (args: Parameters<NotesTools[K]>[0]) => Promise<unknown>;
};

/** One MCP server for one request, acting for the signed-in owner. */
export function buildServer(tools: ToolsApi): McpServer {
  const server = new McpServer(
    { name: 'goblin-mode', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        'Find notes whose title, text or synonyms contain every word of the query, newest first.',
      inputSchema: {
        query: z.string().min(1),
        includeArchived: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: read,
    },
    run((a) => tools.searchNotes(a)),
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List recent notes',
      description: 'Notes newest first, optionally only those changed since a time.',
      inputSchema: {
        since: time.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        includeArchived: z.boolean().optional(),
      },
      annotations: read,
    },
    run((a) => tools.listNotes(a)),
  );

  server.registerTool(
    'get_note',
    {
      title: 'Read a note',
      description: 'One note in full, with its links and the notes that link to it.',
      inputSchema: { id: z.string().min(1) },
      annotations: read,
    },
    run((a) => tools.getNote(a)),
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description:
        'A new note in markdown. Without a title, the app shows its first words. ' +
        "Use Eric's words verbatim when filing something he said.",
      inputSchema: {
        body: z.string().min(1),
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: write,
    },
    run((a) => tools.createNote(a)),
  );

  server.registerTool(
    'update_note',
    {
      title: 'Change a note',
      description:
        'Replace a note body, set its title or tags, or archive it. The body replaces the old ' +
        'one entirely: keep every paragraph Eric wrote word for word unless he asked otherwise. ' +
        "A title Eric set himself cannot be changed. The version you replace stays in the note's History.",
      inputSchema: {
        id: z.string().min(1),
        body: z.string().optional(),
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
        archived: z.boolean().optional(),
      },
      annotations: write,
    },
    run((a) => tools.updateNote(a)),
  );

  server.registerTool(
    'list_reminders',
    {
      title: 'List reminders',
      description:
        'Open and snoozed reminders, soonest first; with includeDone, finished ones too.',
      inputSchema: { includeDone: z.boolean().optional() },
      annotations: read,
    },
    run((a) => tools.listReminders(a)),
  );

  server.registerTool(
    'create_reminder',
    {
      title: 'Create a reminder',
      description:
        'A reminder in Right Now, pushed to Eric at its time. Without dueAt it is Someday. ' +
        'repeat needs timeZone (an IANA zone); the repeat keeps the local time of dueAt, or 9 am.',
      inputSchema: {
        text: z.string().min(1),
        dueAt: time.optional(),
        repeat: z.enum(['daily', 'weekdays', 'weekly']).optional(),
        timeZone: z.string().optional(),
        noteId: z.string().optional(),
      },
      annotations: write,
    },
    run((a) => tools.createReminder(a)),
  );

  server.registerTool(
    'update_reminder',
    {
      title: 'Change a reminder',
      description:
        'Change its text or note, move its time (null makes it Someday), snooze it, or mark it ' +
        'done (a repeating one moves to its next time).',
      inputSchema: {
        id: z.string().min(1),
        text: z.string().optional(),
        dueAt: time.nullable().optional(),
        snoozeUntil: time.optional(),
        done: z.boolean().optional(),
        noteId: z.string().optional(),
      },
      annotations: write,
    },
    run((a) => tools.updateReminder(a)),
  );

  return server;
}
