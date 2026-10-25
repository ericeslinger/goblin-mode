// An item assigned to the assistant (#144 step 4), pure over a store, a
// model and the garden's tools. The research model reads the web with
// no tools that act; the server then writes what it found under the
// item, as the agent Mossgoblin, and ticks it.
import { createHash } from 'node:crypto';
import { FINDINGS_MARK, STATUS_MARK, assignedItems, findingsLines } from '@mossgoblin/schema';
import type { NotesTools } from '../mcp/tools';
import { DAILY_RUNS, type RunDeps, type RunOutcome, type RunStore } from './core';
import { research } from './research';

/** UTC day, YYYY-MM-DD. */
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The run id for an item: one per note and item text, so a settle never starts it twice. */
export function itemRunId(noteId: string, itemKey: string): string {
  return `item-${noteId}-${createHash('sha256').update(itemKey).digest('hex').slice(0, 16)}`;
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
  const sayUnder = async (line: string, findings: string[] = []) => {
    await tools.answerItem({
      id: noteId,
      key,
      lines: [...findings, `- ${STATUS_MARK} ${line}`],
      tick: false,
    });
  };
  if (claim.status === 'capped') {
    // Retried at the next settle (review on #158), as is a missing key.
    const error = `Today’s ${DAILY_RUNS} runs are used up; try again tomorrow.`;
    await deps.store.update(uid, runId, { status: 'failed', error, retryable: true });
    await sayUnder(error).catch(() => undefined);
    return 'capped';
  }
  try {
    const body = await deps.body(uid, noteId);
    const item = body === undefined ? undefined : assignedItems(body).find((i) => i.key === key);
    if (!item) throw new ItemGoneError('the item is gone, or changed');
    if (item.done) throw new ItemGoneError('the item was ticked meanwhile');
    const out = await deps.withModel(uid, (model) =>
      research(model, item.text, undefined, deps.now),
    );
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
    if (out.stopped !== 'done') {
      // Cut short: what was found goes in, unticked, and says so.
      await sayUnder(
        'Stopped before finishing; the findings above may be partial.',
        findingsLines(out.findings),
      );
      await deps.store.update(uid, runId, {
        status: 'failed',
        error: `cut short (${out.stopped})`,
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
    // No key yet: retried at the next settle once one is saved.
    const retryable = /Add an? \w+ key in Settings/.test(message);
    await deps.store.update(uid, runId, {
      status: 'failed',
      error: message,
      ...(retryable ? { retryable: true } : {}),
    });
    return 'failed';
  }
}

/** The item is no longer this run's: gone, changed, or ticked by Eric. */
export class ItemGoneError extends Error {}

export type { RunStore };
