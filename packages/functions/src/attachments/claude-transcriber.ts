import Anthropic from '@anthropic-ai/sdk';
import { CUT_OFF, type Transcriber } from './transcribe';

/** Reading handwriting and receipts well is worth a mid-size model. */
export const TRANSCRIBE_MODEL = 'claude-sonnet-5-5';

const SYSTEM =
  'You transcribe photos and documents for a personal notes app. Reply with the transcription ' +
  'only: the words as written, in their order, keeping line breaks, spelling and numbers. Use ' +
  'markdown lists, checkboxes ("- [ ]") and headings only where the original has them. Write ' +
  '[illegible] for a word you cannot read. Add nothing of your own.';

/**
 * Claude's transcription (#47) on the gardener's own Anthropic key
 * (#144 step 2): a client per call, built from the key opened for it,
 * and dropped with it.
 */
export function claudeTranscriber(apiKey: string): Transcriber {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 240_000 });
  return async (input) => {
    const data = Buffer.from(input.bytes).toString('base64');
    const file =
      input.kind === 'pdf'
        ? ({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data },
          } as const)
        : ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } } as const);
    const message = await client.messages.create({
      model: TRANSCRIBE_MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content: [file, { type: 'text', text: 'Transcribe this.' }] }],
    });
    const text = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();
    // Cut off: said, so a part is never taken for the whole (review on #102).
    return message.stop_reason === 'max_tokens' ? `${text}\n\n${CUT_OFF}` : text;
  };
}
