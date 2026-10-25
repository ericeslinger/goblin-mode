// The agent loop (#144 step 3), pure over a model and the garden's
// tools: a brief goes in, tool calls go round until the model stops or
// the budget runs out, and the model's last words come out.
import { RUN_MAX_INPUT_TOKENS, RUN_MAX_STEPS } from '@mossgoblin/schema';
import type { GardenTools } from './garden-tools';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { AgentModel, ContentBlock, MessageParam } from './model';

export interface StepTaken {
  tool: string;
  ok: boolean;
}

export interface LoopOutcome {
  /** The model's closing text, if it gave any. */
  text: string;
  /** How the loop ended: the model stopped, or a budget did. */
  stopped: 'done' | 'steps' | 'tokens' | 'refused';
  steps: StepTaken[];
  inputTokens: number;
}

const textOf = (content: ContentBlock[]) =>
  content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();

export async function runLoop(
  model: AgentModel,
  garden: GardenTools,
  brief: string,
  onStep?: (step: StepTaken) => Promise<void>,
  limits = { steps: RUN_MAX_STEPS, inputTokens: RUN_MAX_INPUT_TOKENS },
): Promise<LoopOutcome> {
  const messages: MessageParam[] = [{ role: 'user', content: brief }];
  const steps: StepTaken[] = [];
  let inputTokens = 0;
  let text = '';
  for (;;) {
    const turn = await model({ system: garden.instructions, messages, tools: garden.tools });
    inputTokens += turn.inputTokens;
    text = textOf(turn.content) || text;
    messages.push({ role: 'assistant', content: turn.content });
    if (turn.stop_reason === 'refusal') return { text, stopped: 'refused', steps, inputTokens };
    const calls = turn.content.filter((b) => b.type === 'tool_use');
    if (turn.stop_reason !== 'tool_use' || calls.length === 0) {
      return { text, stopped: 'done', steps, inputTokens };
    }
    if (inputTokens > limits.inputTokens) return { text, stopped: 'tokens', steps, inputTokens };
    // A tool's reply to the model: its text, as an error when it was one.
    const results: ToolResultBlockParam[] = [];
    for (const call of calls) {
      if (steps.length >= limits.steps) return { text, stopped: 'steps', steps, inputTokens };
      const result = await garden.call(call.name, call.input);
      const step = { tool: call.name, ok: !result.isError };
      steps.push(step);
      await onStep?.(step);
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: result.text,
        is_error: result.isError,
      });
    }
    messages.push({ role: 'user', content: results });
  }
}
