// A run of the garden's own agent (#144 step 3): a note sent to an
// assistant, done at once on the gardener's own key instead of waiting
// for the hourly routine. Written by the functions under
// users/{uid}/runs, read by the app to show progress on the note.
import { z } from 'zod';
import { Timestamp } from './model';

/** The agent the garden runs for itself, as writes name it (#142). */
export const GARDEN_AGENT = 'Mossgoblin';

export const RunStatus = z.enum(['requested', 'working', 'done', 'failed']);
export type RunStatus = z.infer<typeof RunStatus>;

/** One tool call the run made. */
export const RunStep = z.object({
  at: Timestamp,
  tool: z.string().min(1),
  ok: z.boolean(),
});
export type RunStep = z.infer<typeof RunStep>;

export const Run = z.object({
  /** A sent note done now (step 3), or an item assigned with @goblin (step 4). */
  kind: z.enum(['queued-note', 'item']),
  noteId: z.string().min(1),
  /** A sent note's `sentAt` when the run was asked for, as finish_queued needs it. */
  sentAt: Timestamp.optional(),
  /** An assigned item's ask, and what names it across edits (step 4). */
  itemText: z.string().optional(),
  itemKey: z.string().optional(),
  status: RunStatus,
  steps: z.array(RunStep),
  /** The one line the run ends with, or why it failed. */
  outcome: z.string().optional(),
  error: z.string().optional(),
  /** Input tokens the run spent, for the gardener's own bill. */
  tokens: z.number().int().nonnegative().optional(),
  createdAt: Timestamp,
  startedAt: Timestamp.optional(),
  finishedAt: Timestamp.optional(),
});
export type Run = z.infer<typeof Run>;

/**
 * Where a run stops on its own: tool calls, input tokens, and time, per
 * run. The time leaves room, inside the trigger's 540 s, for one more
 * turn at its worst (a 120 s timeout and one retry, 240 s) and for
 * finishing the note (review on #152).
 */
export const RUN_MAX_STEPS = 30;
export const RUN_MAX_INPUT_TOKENS = 400_000;
export const RUN_MAX_MS = 240_000;
/** A run working longer than this is taken for lost (its function was killed). */
export const RUN_STALE_MS = 10 * 60_000;
