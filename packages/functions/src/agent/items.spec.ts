import { describe, expect, it, vi } from 'vitest';
import type { NotesTools } from '../mcp/tools';
import type { RunStore } from './core';
import { ItemRunDeps, executeItemRun, itemRunId } from './items';
import type { AgentModel, ContentBlock } from './model';
import { RESEARCH_SYSTEM, WEB_SEARCH, research } from './research';

const NOW = Date.parse('2026-10-25T20:00:00Z');
const NOTE = '- [ ] research good Xmas presents for my nephews @goblin\n- [ ] wrap them';
const KEY = 'research good xmas presents for my nephews';

const say = (text: string): ContentBlock => ({ type: 'text', text, citations: null });
const searched: ContentBlock = {
  type: 'server_tool_use',
  id: 's1',
  name: 'web_search',
  input: { query: 'presents' },
  caller: { type: 'direct' },
};

/** A model that pauses after a search, then answers. */
function researcher(answer = 'Lego, from https://a.example'): AgentModel & { seen: unknown[] } {
  let n = 0;
  const seen: unknown[] = [];
  const model = (async (req) => {
    seen.push(req);
    n++;
    if (n === 1) return { content: [searched], stop_reason: 'pause_turn', inputTokens: 500 };
    return { content: [searched, say(answer)], stop_reason: 'end_turn', inputTokens: 700 };
  }) as AgentModel & { seen: unknown[] };
  model.seen = seen;
  return model;
}

describe('research (#144 step 4)', () => {
  it('gives the model web search and nothing else, continues past a pause, and keeps the words', async () => {
    const model = researcher();
    const out = await research(model, 'good Xmas presents for my nephews');
    expect(out).toEqual({
      findings: 'Lego, from https://a.example',
      inputTokens: 1200,
      searches: 2,
      stopped: 'done',
    });
    const first = model.seen[0] as { system: string; tools: unknown[]; messages: unknown[] };
    expect(first.system).toBe(RESEARCH_SYSTEM);
    expect(first.tools).toEqual([WEB_SEARCH]);
    expect(first.messages[0]).toEqual({
      role: 'user',
      content: 'Research: good Xmas presents for my nephews',
    });
  });

  it('stops at its deadline, after its turns, or on a refusal', async () => {
    let clock = 0;
    const slow = researcher();
    const timed = await research(slow, 'x', 100, () => (clock += 120));
    expect(timed).toMatchObject({ stopped: 'time', findings: '' });
    expect(slow.seen).toHaveLength(1);
    const pausing: AgentModel = async () => ({
      content: [searched],
      stop_reason: 'pause_turn',
      inputTokens: 1,
    });
    expect(await research(pausing, 'x')).toMatchObject({ stopped: 'turns', findings: '' });
    const refusing: AgentModel = async () => ({
      content: [say('no')],
      stop_reason: 'refusal',
      inputTokens: 1,
    });
    expect(await research(refusing, 'x')).toMatchObject({ stopped: 'refused', findings: '' });
  });
});

function deps(body: string | undefined, model: AgentModel = researcher(), claimed = true) {
  const run = { kind: 'item', noteId: 'n1', itemKey: KEY, itemText: 'x', status: 'working' };
  const store = {
    claim: vi.fn(async () =>
      claimed ? { status: 'claimed' as const, run } : { status: 'skip' as const },
    ),
    update: vi.fn(async (_u: string, _r: string, _f: Record<string, unknown>) => undefined),
    step: vi.fn(async () => undefined),
    noteState: vi.fn(async () => undefined),
  } satisfies RunStore;
  const answerItem = vi.fn(async () => ({ id: 'n1', changed: true }));
  const d: ItemRunDeps = {
    store,
    withModel: (_uid, use) => use(model),
    now: () => NOW,
    tools: () => ({ answerItem }) as unknown as NotesTools,
    body: async () => body,
  };
  return { d, store, answerItem };
}

describe('executeItemRun', () => {
  it('researches the item and writes the findings under it, ticked', async () => {
    const { d, store, answerItem } = deps(NOTE);
    expect(await executeItemRun(d, 'u1', 'r1')).toBe('done');
    expect(answerItem).toHaveBeenCalledWith({
      id: 'n1',
      key: KEY,
      lines: ['- ✳ Mossgoblin, from the web:', '  - Lego, from https://a.example'],
      tick: true,
    });
    expect(store.step).toHaveBeenCalledWith('u1', 'r1', { tool: 'web_search', ok: true });
    expect(store.update).toHaveBeenLastCalledWith('u1', 'r1', {
      status: 'done',
      outcome: '✳ Mossgoblin, from the web: 2 searches',
      tokens: 1200,
    });
  });

  it('writes partial findings unticked when cut short', async () => {
    const pausing: AgentModel = async () => ({
      content: [searched, say('So far: Lego')],
      stop_reason: 'pause_turn',
      inputTokens: 1,
    });
    const { d, answerItem, store } = deps(NOTE, pausing);
    expect(await executeItemRun(d, 'u1', 'r1')).toBe('failed');
    expect(answerItem).toHaveBeenCalledWith({
      id: 'n1',
      key: KEY,
      lines: [
        '- ✳ Mossgoblin, from the web:',
        '  - So far: Lego',
        '- ✳ Mossgoblin: Stopped before finishing; the findings above may be partial.',
      ],
      tick: false,
    });
    expect(store.update).toHaveBeenLastCalledWith(
      'u1',
      'r1',
      expect.objectContaining({ status: 'failed', error: 'cut short (turns)' }),
    );
  });

  it('says under the item why it could not, and leaves it unticked', async () => {
    const noKey = deps(NOTE);
    noKey.d.withModel = async () => {
      throw new Error('Add an Anthropic key in Settings, AI assistants, to do it now.');
    };
    expect(await executeItemRun(noKey.d, 'u1', 'r1')).toBe('failed');
    expect(noKey.answerItem).toHaveBeenCalledWith({
      id: 'n1',
      key: KEY,
      lines: [
        '- ✳ Mossgoblin: Could not do it: Add an Anthropic key in Settings, AI assistants, to do it now.',
      ],
      tick: false,
    });
    // Mended by saving a key: the next settle may start it again.
    expect(noKey.store.update).toHaveBeenLastCalledWith(
      'u1',
      'r1',
      expect.objectContaining({ retryable: true }),
    );
    const nothing = deps(NOTE, researcher(''));
    expect(await executeItemRun(nothing.d, 'u1', 'r1')).toBe('failed');
    expect(String(nothing.store.update.mock.calls.at(-1)![2]['error'])).toBe('nothing was found');
  });

  it('leaves an item alone that is gone or ticked meanwhile, and skips a claimed run', async () => {
    const gone = deps('- [ ] something else @goblin');
    expect(await executeItemRun(gone.d, 'u1', 'r1')).toBe('failed');
    expect(gone.answerItem).not.toHaveBeenCalled();
    expect(String(gone.store.update.mock.calls[0][2]['error'])).toContain('gone');
    const ticked = deps(NOTE.replace('- [ ]', '- [x]'));
    expect(await executeItemRun(ticked.d, 'u1', 'r1')).toBe('failed');
    expect(ticked.answerItem).not.toHaveBeenCalled();
    const skipped = deps(NOTE, researcher(), false);
    expect(await executeItemRun(skipped.d, 'u1', 'r1')).toBe('skipped');
  });

  it('names a run by the note and the item, the same each time', () => {
    expect(itemRunId('n1', KEY)).toBe(itemRunId('n1', KEY));
    expect(itemRunId('n1', KEY)).not.toBe(itemRunId('n2', KEY));
    expect(itemRunId('n1', KEY)).toMatch(/^item-n1-[0-9a-f]{16}$/);
  });
});
