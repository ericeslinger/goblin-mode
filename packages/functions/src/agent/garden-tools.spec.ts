import { describe, expect, it, vi } from 'vitest';
import type { ToolsApi } from '../mcp/server';
import { DENIED_FOR_NOTE_RUN, gardenTools } from './garden-tools';

/** Every tool answers with its name and arguments. */
function tools(): ToolsApi {
  return new Proxy({} as ToolsApi, {
    get: (_t, name) => vi.fn(async (args: unknown) => ({ called: name, args })),
  });
}

describe('gardenTools (#144 step 3)', () => {
  it('offers the server’s tools and runs them in process', async () => {
    const g = await gardenTools(tools(), '', ['projects']);
    expect(g.instructions).toContain('Mossgoblin');
    expect(g.tools.map((t) => t.name)).toContain('finish_queued');
    expect(g.tools.find((t) => t.name === 'get_note')?.input_schema).toMatchObject({
      type: 'object',
    });
    const out = await g.call('get_note', { id: 'n1' });
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text)).toEqual({ called: 'getNote', args: { id: 'n1' } });
    await g.close();
  });

  it('scoped to one sent note, hides the tools a run may not use and binds finish_queued', async () => {
    const g = await gardenTools(tools(), '', undefined, { noteId: 'n1', sentAt: 'T' });
    const names = g.tools.map((t) => t.name);
    for (const denied of DENIED_FOR_NOTE_RUN) expect(names).not.toContain(denied);
    expect((await g.call('list_queue', {})).isError).toBe(true);
    expect((await g.call('add_attachment', { url: 'https://evil.example/?x' })).isError).toBe(true);
    const finished = await g.call('finish_queued', { id: 'other', sentAt: 'X', outcome: 'Done' });
    expect(JSON.parse(finished.text)).toEqual({
      called: 'finishQueued',
      args: { id: 'n1', sentAt: 'T', outcome: 'Done' },
    });
    await g.close();
  });
});
