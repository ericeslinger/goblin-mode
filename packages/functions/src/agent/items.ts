// An item assigned to the assistant (#144 step 4), pure over a store, a
// model and the garden's tools. The research model reads the web with
// no tools that act; the server then writes what it found under the
// item, as the agent Mossgoblin, and ticks it.
import { FINDINGS_MARK, assignedItems, findingsLines } from '@mossgoblin/schema';
import type { NotesTools } from '../mcp/tools';
import { DAILY_RUNS, type RunDeps, type RunOutcome, type RunStore } from './core';
import { research } from './research';

/** UTC day, YYYY-MM-DD. */
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The run id for an item: one per note and item text, so a settle never starts it twice. */
export function itemRunId(noteId: string, itemKey: string): string {
  let h = 0;
  for (const c of itemKey) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `item-${noteId}-${h.toString(36)}`;
}

export type ItemRunDeps = Pick<RunDeps, 'store' | 'withModel' | 'now'> & {
  /** The garden's tools as the agent, for writing under the item. */
  tools(uid: string): NotesTools;
  /** The note's text now. */
  body(uid: string, noteId: string): Promise<string | undefined>;
};

export async function executeItemRun(
  deps: ItemRunDeps,
  uid: string,
  runId: string,
): Promise<RunOutcome> {
  const claim = await deps.store.claim(uid, runId, dayOf(deps.now()), DAILY_RUNS);
  if (claim.status === 'skip') return 'skipped';
  const run = claim.status === 'claimed' ? claim.run : undefined;
  const noteId = typeof run?.noteId === 'string' ? run.noteId : '';
  const key = typeof run?.itemKey === 'string' ? run.itemKey : '';
  const tools = deps.tools(uid);
  /** What the item gets when the run cannot research it: one line saying why. */
  const sayUnder = async (line: string) => {
    await tools.answerItem({ id: noteId, key, lines: [`- ✳ Mossgoblin: ${line}`], tick: false });
  };
  if (claim.status === 'capped') {
    const error = `Today’s ${DAILY_RUNS} runs are used up; try again tomorrow.`;
    await deps.store.update(uid, runId, { status: 'failed', error });
    await sayUnder(error).catch(() => undefined);
    return 'capped';
  }
  try {
    const body = await deps.body(uid, noteId);
    const item = body === undefined ? undefined : assignedItems(body).find((i) => i.key === key);
    if (!item) throw new ItemGoneError('the item is gone, or changed');
    if (item.done) throw new ItemGoneError('the item was ticked meanwhile');
    const out = await deps.withModel(uid, (model) => research(model, item.text));
    await deps.store.step(uid, runId, { tool: 'web_search', ok: out.stopped !== 'refused' });
    if (out.stopped === 'refused' || !out.findings) {
      const why =
        out.stopped === 'refused' ? 'the model declined to research this' : 'nothing was found';
      await sayUnder(`Could not do it: ${why}.`);
      await deps.store.update(uid, runId, {
        status: 'failed',
        error: why,
        tokens: out.inputTokens,
      });
      return 'failed';
    }
    await tools.answerItem({ id: noteId, key, lines: findingsLines(out.findings), tick: true });
    await deps.store.update(uid, runId, {
      status: 'done',
      outcome: `${FINDINGS_MARK} ${out.searches} searches`,
      tokens: out.inputTokens,
    });
    return 'done';
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    if (!(err instanceof ItemGoneError)) {
      await sayUnder(`Could not do it: ${message}`).catch(() => undefined);
    }
    await deps.store.update(uid, runId, { status: 'failed', error: message });
    return 'failed';
  }
}

/** The item is no longer this run's: gone, changed, or ticked by Eric. */
export class ItemGoneError extends Error {}

export type { RunStore };
