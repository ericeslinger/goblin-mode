import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { INSTRUCTIONS, type ToolsApi, buildServer, instructionsWith } from './server';
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
    getContext: vi.fn(async () => ({ id: 'context', text: '' })),
    getModules: vi.fn(async () => ['projects' as const]),
    createRecipe: vi.fn(async () => ({})),
    importRecipe: vi.fn(async () => ({})),
    getMealPlan: vi.fn(async () => ({})),
    planMeal: vi.fn(async () => ({})),
    logMeal: vi.fn(async () => ({})),
    getPantry: vi.fn(async () => ({})),
    updatePantry: vi.fn(async () => ({})),
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
      'create_recipe',
      'create_reminder',
      'get_attachment_text',
      'get_backlinks',
      'get_context',
      'get_meal_plan',
      'get_note',
      'get_pantry',
      'import_recipe',
      'link_notes',
      'list_concepts',
      'list_notes',
      'list_reading_queue',
      'list_reminders',
      'list_templates',
      'log_meal',
      'merge_notes',
      'plan_meal',
      'refile',
      'search_attachments',
      'search_notes',
      'split_note',
      'suggest_changes',
      'uncheck_item',
      'update_note',
      'update_pantry',
      'update_reminder',
      'use_template',
    ]);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toMatch(/word for word/);
  });

  it('tells Claude which modules are on, and what an off one means (#126)', () => {
    expect(instructionsWith('', ['projects', 'kitchen'])).toBe(
      `${INSTRUCTIONS}\n\nModules Eric has on: Projects, Kitchen.`,
    );
    expect(instructionsWith('', ['projects'])).toMatch(
      /Modules Eric has on: Projects\. Switched off: Kitchen\./,
    );
    const off = instructionsWith('Fish on Wednesdays.', []);
    expect(off).toMatch(/Modules Eric has on: none\. Switched off: Projects, Kitchen\./);
    expect(off).toMatch(/switched off in Settings, Modules\.\n\nContext for Claude/);
  });

  it('gives Claude Eric’s Context for Claude after the rules, when there is any (#113)', async () => {
    expect(instructionsWith('  ')).toBe(INSTRUCTIONS);
    const told = instructionsWith('Fish comes most Wednesdays.\n');
    expect(told.startsWith(INSTRUCTIONS)).toBe(true);
    expect(told).toMatch(
      /Context for Claude, from Eric \(the context note\):\nFish comes most Wednesdays\.$/,
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer(fakeTools(), 'Fish comes most Wednesdays.').connect(serverSide);
    const client = new Client({ name: 'spec', version: '1' });
    await client.connect(clientSide);
    expect(client.getInstructions()).toContain('Fish comes most Wednesdays.');
    expect(INSTRUCTIONS).toMatch(/note with id context/);
  });

  it('carries the conventions and procedures a chat without the repo cannot guess', () => {
    // Project page shape and the garden-this procedure (#104).
    expect(INSTRUCTIONS).toMatch(
      /Overview, Working notes, Tasks, Ideas, Open questions, Decisions and Links/,
    );
    expect(INSTRUCTIONS).toMatch(/file nothing without his yes/);
    expect(INSTRUCTIONS).toMatch(/capture once per\s+item/);
    expect(INSTRUCTIONS).toMatch(/timeZone and source/);
    expect(INSTRUCTIONS).toMatch(/what was filed, one line each/);
    // Naming conventions (#105).
    expect(INSTRUCTIONS).toMatch(/c-<slug>, e\.g\. c-mossgoblin/);
    expect(INSTRUCTIONS).toMatch(
      /by hand .* with '✳ Claude:' .*; capture adds the mark to its summary/,
    );
    expect(INSTRUCTIONS).toMatch(/titleSource .* words .* llm .* user/);
    expect(INSTRUCTIONS).toMatch(/Right Now, the reminders screen/);
    // Lists, attachments and concepts (#106).
    expect(INSTRUCTIONS).toMatch(
      /add_lines, check_item and uncheck_item rather than rewriting it with update_note/,
    );
    expect(INSTRUCTIONS).toMatch(/search_attachments and get_attachment_text/);
    expect(INSTRUCTIONS).toMatch(/list_reading_queue .* add_attachment/);
    expect(INSTRUCTIONS).toMatch(/create_concept makes a new person, project or other concept/);
    // Loose notes (#107).
    expect(INSTRUCTIONS).toMatch(/linked to no project.*list_notes or search_notes/);
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
