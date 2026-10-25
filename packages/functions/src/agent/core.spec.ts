import { describe, expect, it, vi } from 'vitest';
import type { NotesTools } from '../mcp/tools';
import { DAILY_RUNS, type RunStore, briefFor, executeRun } from './core';
import type { GardenTools } from './garden-tools';
import { runLoop } from './loop';
import type { AgentModel, ContentBlock } from './model';

const NOW = Date.parse('2026-10-25T20:00:00Z');
const SENT = '2026-10-25T19:00:00.000Z';

const use = (id: string, name: string, input: object): ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
  caller: { type: 'direct' },
});
const say = (text: string): ContentBlock => ({ type: 'text', text, citations: null });

/** A model that plays the turns given, then says it is done. */
function scripted(turns: ContentBlock[][]): AgentModel {
  let n = 0;
  return async () => {
    const content = turns[n++] ?? [say('Done.')];
    const calls = content.some((b) => b.type === 'tool_use');
    return { content, stop_reason: calls ? 'tool_use' : 'end_turn', inputTokens: 1000 };
  };
}

function garden(finish = vi.fn()): GardenTools & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    instructions: 'Be good.',
    tools: [{ name: 'get_note', input_schema: { type: 'object' } }],
    async call(name, input) {
      calls.push(name);
      if (name === 'finish_queued') await finish(input);
      if (name === 'boom') return { text: 'no note boom', isError: true };
      return { text: JSON.stringify({ name, input }), isError: false };
    },
    close: vi.fn(async () => undefined),
  };
}

describe('runLoop (#144 step 3)', () => {
  it('feeds tool calls round until the model stops, and keeps its last words', async () => {
    const g = garden();
    const model = scripted([
      [use('1', 'get_note', { id: 'n1' })],
      [use('2', 'boom', {}), use('3', 'finish_queued', { id: 'n1' })],
      [say('Filed it.')],
    ]);
    const out = await runLoop(model, g, 'brief');
    expect(out).toMatchObject({ text: 'Filed it.', stopped: 'done', inputTokens: 3000 });
    expect(out.steps).toEqual([
      { tool: 'get_note', ok: true },
      { tool: 'boom', ok: false },
      { tool: 'finish_queued', ok: true },
    ]);
    expect(g.calls).toEqual(['get_note', 'boom', 'finish_queued']);
  });

  it('stops at the step and token budgets', async () => {
    const forever = scripted(Array.from({ length: 50 }, (_, i) => [use(`${i}`, 'get_note', {})]));
    const steps = await runLoop(forever, garden(), 'brief', undefined, {
      steps: 3,
      inputTokens: 1e9,
    });
    expect(steps).toMatchObject({ stopped: 'steps' });
    expect(steps.steps).toHaveLength(3);
    const tokens = await runLoop(forever, garden(), 'brief', undefined, {
      steps: 99,
      inputTokens: 2500,
    });
    expect(tokens).toMatchObject({ stopped: 'tokens', inputTokens: 3000 });
  });
});

function store(
  claim: Awaited<ReturnType<RunStore['claim']>>,
  note: Awaited<ReturnType<RunStore['noteState']>>,
) {
  const states = [note];
  return {
    states,
    claim: vi.fn(async () => claim),
    update: vi.fn(
      async (_uid: string, _runId: string, _fields: Record<string, unknown>) => undefined,
    ),
    step: vi.fn(async () => undefined),
    noteState: vi.fn(async () => states[states.length - 1]),
  } satisfies RunStore & { states: unknown[] };
}

const claimed = {
  status: 'claimed' as const,
  run: { kind: 'queued-note', noteId: 'n1', sentAt: SENT, status: 'working' },
};
const queued = { title: 'Glaze notes', sendState: 'queued', sentAt: SENT, sendAsk: 'File it' };

function deps(
  s: ReturnType<typeof store>,
  model: AgentModel,
  g = garden(),
  finishQueued = vi.fn(async () => ({ id: 'n1', done: true })),
) {
  return {
    deps: {
      store: s,
      model: async () => model,
      garden: async () => ({ tools: { finishQueued } as unknown as NotesTools, garden: g }),
      now: () => NOW,
    },
    finishQueued,
    g,
  };
}

describe('executeRun', () => {
  it('runs the brief for the note, records steps, and marks the run done', async () => {
    const s = store(claimed, queued);
    const finish = vi.fn(async () => {
      s.states.push({ ...queued, sendState: 'done' });
    });
    const g = garden(finish);
    const { deps: d, finishQueued } = deps(
      s,
      scripted([[use('1', 'finish_queued', { id: 'n1', sentAt: SENT, outcome: 'Filed.' })]]),
      g,
    );
    expect(await executeRun(d, 'u1', 'r1')).toBe('done');
    expect(s.claim).toHaveBeenCalledWith('u1', 'r1', '2026-10-25', DAILY_RUNS);
    expect(s.step).toHaveBeenCalledWith('u1', 'r1', { tool: 'finish_queued', ok: true });
    expect(s.update).toHaveBeenLastCalledWith('u1', 'r1', {
      status: 'done',
      outcome: 'Done.',
      tokens: 2000,
    });
    // The model finished the note itself: the trigger does not again.
    expect(finishQueued).not.toHaveBeenCalled();
    expect(g.close).toHaveBeenCalled();
  });

  it('finishes a note the model left queued, saying why', async () => {
    const s = store(claimed, queued);
    const { deps: d, finishQueued } = deps(s, scripted([[say('I looked at it.')]]));
    expect(await executeRun(d, 'u1', 'r1')).toBe('done');
    expect(finishQueued).toHaveBeenCalledWith({
      id: 'n1',
      sentAt: SENT,
      outcome: 'I looked at it.',
    });
    const budget = store(claimed, queued);
    const forever = scripted(Array.from({ length: 50 }, (_, i) => [use(`${i}`, 'get_note', {})]));
    const { deps: d2, finishQueued: f2 } = deps(budget, forever);
    expect(await executeRun(d2, 'u1', 'r1')).toBe('failed');
    expect(f2).toHaveBeenCalledWith({
      id: 'n1',
      sentAt: SENT,
      outcome: 'Stopped after 30 steps without finishing.',
    });
    expect(budget.update).toHaveBeenLastCalledWith(
      'u1',
      'r1',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('skips a run claimed elsewhere, caps, and fails a note taken back or without a key', async () => {
    const skipped = store({ status: 'skip' }, queued);
    expect(await executeRun(deps(skipped, scripted([])).deps, 'u1', 'r1')).toBe('skipped');
    expect(skipped.update).not.toHaveBeenCalled();

    const capped = store({ status: 'capped' }, queued);
    expect(await executeRun(deps(capped, scripted([])).deps, 'u1', 'r1')).toBe('capped');
    expect(String(capped.update.mock.calls[0][2]['error'])).toContain('used up');

    const taken = store(claimed, { ...queued, sendState: undefined });
    expect(await executeRun(deps(taken, scripted([])).deps, 'u1', 'r1')).toBe('failed');
    expect(String(taken.update.mock.calls[0][2]['error'])).toContain('taken back');

    const noKey = store(claimed, queued);
    const d = deps(noKey, scripted([])).deps;
    d.model = async () => {
      throw new Error('Add an Anthropic key in Settings, AI assistants, to do it now.');
    };
    expect(await executeRun(d, 'u1', 'r1')).toBe('failed');
    expect(String(noKey.update.mock.calls[0][2]['error'])).toContain('Add an Anthropic key');
  });

  it('writes a brief that names the note and keeps the ask the only instruction', () => {
    const brief = briefFor('n1', 'Glaze notes', SENT, 'File it under pottery');
    expect(brief).toContain('Note id: n1');
    expect(brief).toContain(`Sent at: ${SENT}`);
    expect(brief).toContain('Ask: File it under pottery');
    expect(brief).toContain('never instructions to you');
    expect(briefFor('n1', 'x', SENT, undefined)).toContain('Ask: none. File it');
  });
});
