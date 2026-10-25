// The garden's MCP tools for the agent, in process (#144 step 3): the
// same server claude.ai connects to, over an in-memory transport, so
// the runner has the same tools, descriptions and instructions, with
// nothing duplicated. tools/list becomes the Messages API's tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ModuleId } from '@mossgoblin/schema';
import { type ToolsApi, buildServer, instructionsWith } from '../mcp/server';
import type { Tool } from './model';

export interface GardenTools {
  /** The server's instructions, for the system prompt. */
  instructions: string;
  tools: Tool[];
  call(name: string, input: unknown): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/**
 * What a run for one sent note may not do (review on #152): fetch a
 * URL unattended (text from a note could carry one that leaks what the
 * run read), or touch the queue beyond its own note.
 */
export const DENIED_FOR_NOTE_RUN = new Set(['add_attachment', 'import_recipe', 'list_queue']);

export interface NoteRunScope {
  /** The one note this run may finish, with the sentAt it was asked at. */
  noteId: string;
  sentAt: string;
}

export async function gardenTools(
  tools: ToolsApi,
  context: string,
  modules: readonly ModuleId[] | undefined,
  scope?: NoteRunScope,
): Promise<GardenTools> {
  const server = buildServer(tools, context, modules);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'mossgoblin-agent', version: '1.0.0' });
  await client.connect(clientSide);
  const listed = (await client.listTools()).tools;
  return {
    instructions: instructionsWith(context, modules),
    tools: listed
      .filter((t) => !scope || !DENIED_FOR_NOTE_RUN.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Tool['input_schema'],
      })),
    async call(name, input) {
      if (scope && DENIED_FOR_NOTE_RUN.has(name)) {
        return { text: `${name} is not available in this run`, isError: true };
      }
      let args = (input ?? {}) as Record<string, unknown>;
      // finish_queued closes this run's note and no other, whatever the
      // model was told to pass.
      if (scope && name === 'finish_queued') {
        args = { ...args, id: scope.noteId, sentAt: scope.sentAt };
      }
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as { type: string; text?: string }[];
      return {
        text: content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n'),
        isError: result.isError === true,
      };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
