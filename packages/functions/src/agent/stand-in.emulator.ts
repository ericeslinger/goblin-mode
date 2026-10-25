// EMULATOR_ONLY: a scripted model for the emulator, which is off the
// network: it reads the note it was sent, finishes it with one line,
// and stops, so a journey can follow a run from Do it now to Done.
// Swapped in for stand-in.ts by the emulator build alone.
import { logger } from 'firebase-functions/v2';
import type { AgentModel, ContentBlock } from './model';

let said = false;

/** The brief's "Note id:" and "Sent at:" lines, as briefFor writes them. */
function fromBrief(text: string, label: string): string {
  return new RegExp(`^${label}: (.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
}

export function standInModel(env: NodeJS.ProcessEnv): AgentModel | undefined {
  if (env['FUNCTIONS_EMULATOR'] !== 'true' || !env['FIRESTORE_EMULATOR_HOST']) return undefined;
  if (!said) {
    logger.warn('EMULATOR_ONLY: the agent runs on a scripted stand-in, not Claude');
    said = true;
  }
  return async ({ messages }) => {
    const first = messages[0]?.content;
    const brief = typeof first === 'string' ? first : '';
    const id = fromBrief(brief, 'Note id');
    const sentAt = fromBrief(brief, 'Sent at');
    const turns = messages.filter((m) => m.role === 'assistant').length;
    const call = (name: string, input: object): ContentBlock[] => [
      { type: 'tool_use', id: `stand-in-${turns}`, name, input, caller: { type: 'direct' } },
    ];
    if (turns === 0)
      return { content: call('get_note', { id }), stop_reason: 'tool_use', inputTokens: 100 };
    if (turns === 1) {
      return {
        content: call('finish_queued', { id, sentAt, outcome: 'Read it (emulator stand-in).' }),
        stop_reason: 'tool_use',
        inputTokens: 100,
      };
    }
    return {
      content: [{ type: 'text', text: 'Read the note and finished it.', citations: null }],
      stop_reason: 'end_turn',
      inputTokens: 100,
    };
  };
}
