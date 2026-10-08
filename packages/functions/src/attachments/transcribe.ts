// Transcribe (#47): a photo of handwriting, a whiteboard or a receipt,
// or a PDF, becomes a note of Claude's transcription that embeds the
// original. The app asks by setting the attachment's `transcribe` to
// 'requested'; this claims it against a per-account daily cap, calls
// Claude, and writes the note as Claude's. Over small interfaces, so it
// runs in specs.
import { ATTACHMENT_SCHEME } from '@mossgoblin/editor/grammar';

/** Transcriptions an account may ask for in a day (UTC), ready for M5. */
export const DAILY_TRANSCRIPTIONS = 20;

/** What Claude reads: an image (JPEG after preparing) or a PDF. */
export interface TranscribeInput {
  kind: 'image' | 'pdf';
  bytes: Uint8Array;
  mediaType: string;
}

/** Claude's transcription of one file, as plain text with light markdown. */
export type Transcriber = (input: TranscribeInput) => Promise<string>;

/** Makes a photo something Claude reads well and within its limits. */
export type ImagePrep = (bytes: Uint8Array) => Promise<Uint8Array>;

export interface TranscribeRecord {
  kind?: unknown;
  name?: unknown;
  path?: unknown;
  transcribe?: unknown;
}

export interface TranscribeStore {
  /**
   * In one transaction: if the record still says 'requested' and the
   * day's count is under `cap`, counts one and marks it 'working'.
   */
  claim(
    uid: string,
    id: string,
    day: string,
    cap: number,
  ): Promise<
    { status: 'claimed'; record: TranscribeRecord } | { status: 'skip' } | { status: 'capped' }
  >;
  read(path: string): Promise<Uint8Array>;
  /** Merges fields into the attachment's record. */
  finish(uid: string, id: string, fields: Record<string, unknown>): Promise<void>;
  /** Writes a note as Claude's; returns its id. */
  writeNote(uid: string, body: string, title: string): Promise<string>;
}

export type TranscribeOutcome = 'done' | 'failed' | 'capped' | 'skipped';

/** The longest PDF Claude is sent, in bytes. */
export const MAX_TRANSCRIBE_PDF = 30 * 1024 * 1024;

/** The note: what it transcribes, the original, and the words marked as Claude's. */
export function transcriptBody(
  id: string,
  name: string,
  kind: 'image' | 'pdf',
  text: string,
): string {
  const label = name.replace(/[[\]]/g, '') || (kind === 'pdf' ? 'document' : 'image');
  const embed =
    kind === 'pdf'
      ? `[${label}](${ATTACHMENT_SCHEME}${id})`
      : `![${label}](${ATTACHMENT_SCHEME}${id})`;
  return [
    `Transcription of ${label}`,
    '',
    embed,
    '',
    '✳ Claude’s transcription:',
    '',
    text.trim(),
  ].join('\n');
}

/** UTC day, YYYY-MM-DD. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function transcribe(
  store: TranscribeStore,
  transcriber: Transcriber | null,
  prepImage: ImagePrep,
  uid: string,
  id: string,
  now: number,
): Promise<TranscribeOutcome> {
  if (!transcriber) {
    await store.finish(uid, id, {
      transcribe: 'failed',
      transcribeError: 'Claude is not set up for this garden yet.',
    });
    return 'failed';
  }
  const claim = await store.claim(uid, id, dayOf(now), DAILY_TRANSCRIPTIONS);
  if (claim.status === 'skip') return 'skipped';
  if (claim.status === 'capped') {
    await store.finish(uid, id, {
      transcribe: 'failed',
      transcribeError: `Today’s ${DAILY_TRANSCRIPTIONS} transcriptions are used up; try again tomorrow.`,
    });
    return 'capped';
  }
  const { record } = claim;
  const name = typeof record.name === 'string' ? record.name : '';
  try {
    const kind = record.kind === 'pdf' ? 'pdf' : record.kind === 'image' ? 'image' : undefined;
    if (!kind || typeof record.path !== 'string') throw new Error('only photos and PDFs');
    const bytes = await store.read(record.path);
    let input: TranscribeInput;
    if (kind === 'pdf') {
      if (bytes.length > MAX_TRANSCRIBE_PDF) throw new Error('the PDF is over 30 MB');
      input = { kind, bytes, mediaType: 'application/pdf' };
    } else {
      input = { kind, bytes: await prepImage(bytes), mediaType: 'image/jpeg' };
    }
    const text = await transcriber(input);
    if (!text.trim()) throw new Error('no text was found');
    const noteId = await store.writeNote(
      uid,
      transcriptBody(id, name, kind, text),
      `Transcription of ${name || kind}`.slice(0, 120),
    );
    await store.finish(uid, id, { transcribe: 'done', transcriptNoteId: noteId });
    return 'done';
  } catch (err) {
    await store.finish(uid, id, {
      transcribe: 'failed',
      transcribeError: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}
