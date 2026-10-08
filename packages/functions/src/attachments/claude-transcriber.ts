import { type FederationConfig, claudeClient } from '../notes/claude-titler';
import type { Transcriber } from './transcribe';

/** Reading handwriting and receipts well is worth a mid-size model. */
export const TRANSCRIBE_MODEL = 'claude-sonnet-5-5';

const SYSTEM =
  'You transcribe photos and documents for a personal notes app. Reply with the transcription ' +
  'only: the words as written, in their order, keeping line breaks, spelling and numbers. Use ' +
  'markdown lists, checkboxes ("- [ ]") and headings only where the original has them. Write ' +
  '[illegible] for a word you cannot read. Add nothing of your own.';

/** Claude's transcription through the same federation as titles (#47). */
export function claudeTranscriber(config: FederationConfig): Transcriber {
  const client = claudeClient(config);
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
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: 'user', content: [file, { type: 'text', text: 'Transcribe this.' }] }],
    });
    return message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();
  };
}
