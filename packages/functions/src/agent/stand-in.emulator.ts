// EMULATOR_ONLY: a scripted model for the emulator, which is off the
// network: it reads the note it was sent, finishes it with one line,
// and stops, so a journey can follow a run from Do it now to Done. A
// ramble (#233) it splits first, a part a paragraph.
// Swapped in for stand-in.ts by the emulator build alone.
import { logger } from 'firebase-functions/v2';
import type { AgentModel, ContentBlock, MessageParam } from './model';

let said = false;

/** The brief's "Note id:" and "Sent at:" lines, as briefFor writes them. */
function fromBrief(text: string, label: string): string {
  return new RegExp(`^${label}: (.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
}

/** The last tool result the run fed back, if any. */
function lastResult(messages: MessageParam[]): { text: string; isError: boolean } {
  const last = messages[messages.length - 1]?.content;
  const result = Array.isArray(last) ? last.find((b) => b.type === 'tool_result') : undefined;
  if (result?.type !== 'tool_result') return { text: '', isError: false };
  return {
    text: typeof result.content === 'string' ? result.content : '',
    isError: result.is_error === true,
  };
}

/**
 * The paragraphs to split the note get_note returned into, or none.
 * The word "ramble" in its first line is the journeys' marker (#233):
 * a note whose first line says it, with two or more paragraphs split
 * by a blank line, is split a part a paragraph; any other note is not.
 */
function rambleParts(result: string): string[] {
  let body = '';
  try {
    const note = JSON.parse(result) as { body?: unknown };
    body = typeof note.body === 'string' ? note.body : '';
  } catch {
    return [];
  }
  if (!/\bramble\b/i.test(body.split('\n')[0] ?? '')) return [];
  const parts = body
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : [];
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
    // A research brief (step 4): fixed findings, no search.
    if (brief.startsWith('Research: ')) {
      return {
        content: [
          {
            type: 'text',
            text: `Findings for "${brief.slice('Research: '.length)}" (emulator stand-in).\n- One thing, from https://example.com/one\n- Another, from https://example.com/two`,
            citations: null,
          },
        ],
        stop_reason: 'end_turn',
        inputTokens: 100,
      };
    }
    const id = fromBrief(brief, 'Note id');
    const sentAt = fromBrief(brief, 'Sent at');
    const turns = messages.filter((m) => m.role === 'assistant').length;
    const call = (name: string, input: object): ContentBlock[] => [
      { type: 'tool_use', id: `stand-in-${turns}`, name, input, caller: { type: 'direct' } },
    ];
    if (turns === 0)
      return { content: call('get_note', { id }), stop_reason: 'tool_use', inputTokens: 100 };
    // The turn after get_note splits a ramble; the outcome says how many.
    const splitInto = messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .flatMap((b) =>
        b.type === 'tool_use' && b.name === 'split_note'
          ? [((b.input as { parts?: unknown[] }).parts ?? []).length]
          : [],
      )[0];
    if (turns === 1) {
      const parts = rambleParts(lastResult(messages).text);
      if (parts.length) {
        return {
          content: call('split_note', { id, parts }),
          stop_reason: 'tool_use',
          inputTokens: 100,
        };
      }
    }
    if (turns === 1 || (turns === 2 && splitInto !== undefined)) {
      const split = lastResult(messages);
      const outcome =
        splitInto === undefined
          ? 'Read it (emulator stand-in).'
          : split.isError
            ? `Could not split it: ${split.text} (emulator stand-in).`
            : `Split it into ${splitInto} notes (emulator stand-in).`;
      return {
        content: call('finish_queued', { id, sentAt, outcome }),
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
