// The model behind the garden's own agent (#144 step 3): Claude on the
// gardener's Anthropic key, through the Messages API with tools. The
// shape here is the little the loop needs, so a scripted stand-in can
// play it under the emulator (stand-in.emulator.ts).
import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  MessageParam,
  StopReason,
  Tool,
  ToolUnion,
} from '@anthropic-ai/sdk/resources/messages/messages';

export type { ContentBlock, MessageParam, Tool, ToolUnion };

/** Filing and research want a mid-size model that reads carefully. */
export const AGENT_MODEL = 'claude-sonnet-5-5';
/** Output tokens per turn: one tool call, or a short closing line. */
export const TURN_MAX_TOKENS = 4096;

export interface ModelTurn {
  content: ContentBlock[];
  stop_reason: StopReason | null;
  /** Input tokens this turn cost, for the run's budget. */
  inputTokens: number;
}

export type AgentModel = (req: {
  system: string;
  messages: MessageParam[];
  /** The garden's tools, or a server tool such as web search (step 4). */
  tools: ToolUnion[];
}) => Promise<ModelTurn>;

/** Claude, on a client built for this run and dropped with it. */
export function anthropicModel(apiKey: string): AgentModel {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120_000 });
  return async ({ system, messages, tools }) => {
    const message = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: TURN_MAX_TOKENS,
      system,
      messages,
      tools,
    });
    return {
      content: message.content,
      stop_reason: message.stop_reason,
      inputTokens: message.usage.input_tokens,
    };
  };
}
