import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { type ToolsApi, buildServer } from './server';

/**
 * DESIGN.md lists every tool the MCP server registers in one table (#106).
 * This spec keeps the two in step, the way `rules:gen -- --check` keeps
 * the rules validators in step with the schemas.
 */

const MARKER = '<!-- mcp-tools-table -->';
const DESIGN = new URL('../../../../DESIGN.md', import.meta.url);

/**
 * The names the built server offers, asked the way a client asks. buildServer
 * only touches `tools` when a tool is called, so an empty stand-in is enough,
 * and listTools is public protocol, not a private field of McpServer.
 */
async function registeredTools(): Promise<string[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer({} as ToolsApi).connect(serverSide);
  const client = new Client({ name: 'tools-table-spec', version: '1' });
  await client.connect(clientSide);
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    names.push(...page.tools.map((t) => t.name));
    cursor = page.nextCursor;
  } while (cursor);
  return names.sort();
}

/** The backticked names in the first column of the table after the marker. */
function documentedTools(markdown: string): string[] {
  const lines = markdown.split('\n');
  const at = lines.findIndex((line) => line.trim() === MARKER);
  if (at < 0) throw new Error(`DESIGN.md has no ${MARKER} line above the tool table`);
  let i = at + 1;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  const rows: string[] = [];
  for (; i < lines.length && lines[i]!.startsWith('|'); i++) rows.push(lines[i]!);
  // The first two rows are the header and the separator.
  const names = rows.slice(2).map((row) => {
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(row);
    if (!match) throw new Error(`a tool table row has no backticked name first: ${row}`);
    return match[1]!;
  });
  return names.sort();
}

describe('the tool table in DESIGN.md', () => {
  it('lists exactly the tools the server registers', async () => {
    const registered = await registeredTools();
    const documented = documentedTools(readFileSync(DESIGN, 'utf8'));
    const missing = registered.filter((name) => !documented.includes(name));
    const extra = documented.filter((name) => !registered.includes(name));
    const problems = [
      missing.length ? `registered but not in the table: ${missing.join(', ')}` : '',
      extra.length ? `in the table but not registered: ${extra.join(', ')}` : '',
    ].filter(Boolean);
    expect(
      problems,
      `DESIGN.md's tool table (under ${MARKER}) has drifted from buildServer. ` +
        'Update INSTRUCTIONS, the table and .claude/skills/garden-this together (CLAUDE.md).',
    ).toEqual([]);
  });

  it('names each tool once', () => {
    const documented = documentedTools(readFileSync(DESIGN, 'utf8'));
    expect(documented.filter((name, i) => documented.indexOf(name) !== i)).toEqual([]);
  });

  it('is found by its marker, with rows under it', () => {
    expect(documentedTools(readFileSync(DESIGN, 'utf8')).length).toBeGreaterThan(0);
  });
});
