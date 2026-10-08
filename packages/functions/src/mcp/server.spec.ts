import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { INSTRUCTIONS, type ToolsApi, buildServer } from './server';
import { ToolError } from './tools';

function fakeTools() {
  return {
    searchNotes: vi.fn(async () => [{ id: 'n1', title: 'Groceries' }]),
    listNotes: vi.fn(async () => []),
    getNote: vi.fn(async () => {
      throw new ToolError('no note n9');
    }),
    createNote: vi.fn(async () => ({ id: 'n2', title: 'Hi' })),
    createConcept: vi.fn(async () => ({ id: 'c-kiln', title: 'Kiln', type: 'project' })),
    updateNote: vi.fn(async () => ({ id: 'n1', updated: [] })),
    listReminders: vi.fn(async () => []),
    createReminder: vi.fn(async () => ({})),
    updateReminder: vi.fn(async () => ({})),
    listConcepts: vi.fn(async () => []),
    getBacklinks: vi.fn(async () => []),
    linkNotes: vi.fn(async () => ({})),
    splitNote: vi.fn(async () => ({})),
    mergeNotes: vi.fn(async () => ({})),
    refile: vi.fn(async () => ({})),
    archiveNote: vi.fn(async () => ({})),
    suggestChanges: vi.fn(async () => ({})),
    listTemplates: vi.fn(async () => []),
    useTemplate: vi.fn(async () => ({})),
    addLines: vi.fn(async () => ({})),
    checkItem: vi.fn(async () => ({})),
    uncheckItem: vi.fn(async () => ({})),
    capture: vi.fn(async () => ({})),
    addAttachment: vi.fn(async () => ({})),
    listReadingQueue: vi.fn(async () => []),
    getAttachmentText: vi.fn(async () => ({})),
    searchAttachments: vi.fn(async () => []),
  } satisfies ToolsApi;
}

async function connect(tools = fakeTools()) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer(tools).connect(serverSide);
  const client = new Client({ name: 'spec', version: '1' });
  await client.connect(clientSide);
  return { client, tools };
}

describe('the MCP server', () => {
  it('offers the tools and tells Claude the rules', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'add_attachment',
      'add_lines',
      'archive_note',
      'capture',
      'check_item',
      'create_concept',
      'create_note',
      'create_reminder',
      'get_attachment_text',
      'get_backlinks',
      'get_note',
      'link_notes',
      'list_concepts',
      'list_notes',
      'list_reading_queue',
      'list_reminders',
      'list_templates',
      'merge_notes',
      'refile',
      'search_attachments',
      'search_notes',
      'split_note',
      'suggest_changes',
      'uncheck_item',
      'update_note',
      'update_reminder',
      'use_template',
    ]);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toMatch(/word for word/);
  });

  it('passes validated arguments to the tools and returns their result as JSON', async () => {
    const { client, tools } = await connect();
    const result = await client.callTool({ name: 'search_notes', arguments: { query: 'milk' } });
    expect(tools.searchNotes).toHaveBeenCalledWith({ query: 'milk' });
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual([
      { id: 'n1', title: 'Groceries' },
    ]);
  });

  it('returns a tool error to Claude instead of failing the call', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'get_note', arguments: { id: 'n9' } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toBe('no note n9');
  });

  it('refuses arguments that break the schema before any tool runs', async () => {
    const { client, tools } = await connect();
    const result = await client.callTool({ name: 'search_notes', arguments: { query: '' } });
    expect(result.isError).toBe(true);
    expect(tools.searchNotes).not.toHaveBeenCalled();
  });
});
