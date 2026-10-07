import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type NotesTools, ToolError } from './tools';

/** What every Claude conversation using the connector is told. */
export const INSTRUCTIONS = [
  "Mossgoblin is Eric's notes app: quick notes, and reminders shown in Right Now.",
  "Keep Eric's paragraphs word for word. You may add your own text, re-file, tag, link, " +
    'split, merge and archive, but never reword what he wrote unless he asks you to.',
  'Prefer archiving to deleting; there is no delete tool.',
  "In Eric's notes *single stars* mean bold and _underscores_ mean italic; " +
    'write emphasis the same way.',
  'Times are ISO 8601 with an offset. Ask Eric for his time zone if you need one and do not know it.',
  'To organize, use list_concepts, get_backlinks, link_notes, split_note, merge_notes, refile ' +
    'and archive_note: they move his text without rewording it. Every change shows in the app ' +
    'under What Claude changed. To suggest instead of change, use suggest_changes.',
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
    { name: 'mossgoblin', version: '1.0.0' },
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
    'list_concepts',
    {
      title: 'List concepts',
      description:
        'The concepts (people, projects and other named things) with their other names and how ' +
        'many notes link to each, most linked first.',
      inputSchema: { type: z.enum(['person', 'project', 'other']).optional() },
      annotations: read,
    },
    run((a) => tools.listConcepts(a)),
  );

  server.registerTool(
    'get_backlinks',
    {
      title: 'Notes linking here',
      description:
        'The notes that link to a note or concept, newest first, each with the sentence around ' +
        'its link.',
      inputSchema: { id: z.string().min(1) },
      annotations: read,
    },
    run((a) => tools.getBacklinks(a)),
  );

  server.registerTool(
    'link_notes',
    {
      title: 'Link notes',
      description:
        'Link one note to others by adding a "See also [[...]]" line at its end. ' +
        "Eric's text is left as it is; notes it already links are skipped.",
      inputSchema: {
        from: z.string().min(1),
        to: z.array(z.string().min(1)).min(1).max(20),
      },
      annotations: write,
    },
    run((a) => tools.linkNotes(a)),
  );

  server.registerTool(
    'split_note',
    {
      title: 'Split a note',
      description:
        'Cut a note into pieces. parts must be the note itself, word for word and in order, cut ' +
        'only where there is whitespace; anything reworded is refused. The first part stays in ' +
        'the note, which links to the new notes made from the rest. History keeps the whole note.',
      inputSchema: {
        id: z.string().min(1),
        parts: z.array(z.string().min(1)).min(2).max(20),
      },
      annotations: write,
    },
    run((a) => tools.splitNote(a)),
  );

  server.registerTool(
    'merge_notes',
    {
      title: 'Merge notes',
      description:
        'Join notes, in the order given, into one new note, each whole with a blank line ' +
        'between. The originals are archived (not deleted) and point to it, and links to their ' +
        'titles follow to the new note. Without a title, the first note decides it.',
      inputSchema: {
        ids: z.array(z.string().min(1)).min(2).max(20),
        title: z.string().optional(),
      },
      annotations: write,
    },
    run((a) => tools.mergeNotes(a)),
  );

  server.registerTool(
    'refile',
    {
      title: 'Refile a note',
      description:
        'File a concept as a person, project or other, give it other names links can use, or ' +
        'add and remove tags on any note. A name another note already answers to is refused.',
      inputSchema: {
        id: z.string().min(1),
        type: z.enum(['person', 'project', 'other']).optional(),
        addSynonyms: z.array(z.string().min(1)).optional(),
        addTags: z.array(z.string().min(1)).optional(),
        removeTags: z.array(z.string().min(1)).optional(),
      },
      annotations: write,
    },
    run((a) => tools.refile(a)),
  );

  server.registerTool(
    'archive_note',
    {
      title: 'Archive a note',
      description:
        'Archive a note (archived: false restores it). Archived notes leave lists and links but ' +
        'are kept; there is no delete.',
      inputSchema: { id: z.string().min(1), archived: z.boolean().optional() },
      annotations: write,
    },
    run((a) => tools.archiveNote(a)),
  );

  server.registerTool(
    'suggest_changes',
    {
      title: 'Suggest changes',
      description:
        'Suggest links, merges and refiles for Eric to accept or dismiss in the app (under What ' +
        'Claude changed). Nothing changes until he accepts; accepting runs link_notes, ' +
        'merge_notes or refile. Each needs a one-sentence reason to Eric. Suggestions the tools ' +
        'could not carry out, or that were suggested before (even if dismissed), are dropped. ' +
        'At most 10 are stored per call and 20 wait at once.',
      inputSchema: {
        proposals: z
          .array(
            z.discriminatedUnion('kind', [
              z.object({
                kind: z.literal('link'),
                from: z.string().min(1).describe('the note to add links to'),
                to: z.array(z.string().min(1)).min(1).describe('the notes it should link'),
                reason: z.string().min(1),
              }),
              z.object({
                kind: z.literal('merge'),
                ids: z.array(z.string().min(1)).min(2).describe('text notes, in order'),
                title: z.string().optional(),
                reason: z.string().min(1),
              }),
              z.object({
                kind: z.literal('refile'),
                id: z.string().min(1).describe('a concept'),
                type: z.enum(['person', 'project', 'other']).optional(),
                synonyms: z.array(z.string().min(1)).optional(),
                reason: z.string().min(1),
              }),
            ]),
          )
          .max(20),
      },
      annotations: write,
    },
    run((a) => tools.suggestChanges(a)),
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
