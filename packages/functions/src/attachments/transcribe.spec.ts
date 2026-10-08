import { describe, expect, it, vi } from 'vitest';
import {
  DAILY_TRANSCRIPTIONS,
  type TranscribeInput,
  type TranscribeRecord,
  type TranscribeStore,
  dayOf,
  transcribe,
  transcriptBody,
} from './transcribe';

const NOW = Date.parse('2026-10-08T23:30:00Z');

function store(
  claim: Awaited<ReturnType<TranscribeStore['claim']>>,
  file = Uint8Array.from([1, 2, 3]),
) {
  return {
    claim: vi.fn(async (_uid: string, _id: string, _day: string, _cap: number) => claim),
    read: vi.fn(async (_path: string) => file),
    finish: vi.fn(async (_uid: string, _id: string, _fields: Record<string, unknown>) => undefined),
    writeNote: vi.fn(async (_uid: string, _body: string, _title: string) => 'n9'),
  } satisfies TranscribeStore;
}

const photo: TranscribeRecord = {
  kind: 'image',
  name: 'Whiteboard',
  path: 'users/u1/attachments/a1/board.jpg',
  transcribe: 'requested',
};

describe('transcribe', () => {
  it('writes a note of Claude’s transcription that embeds the original', async () => {
    const s = store({ status: 'claimed', record: photo });
    const prep = vi.fn(async () => Uint8Array.from([9]));
    const claude = vi.fn(async (_input: TranscribeInput) => '- [ ] buy milk\n- [x] call Vik\n');
    expect(await transcribe(s, claude, prep, 'u1', 'a1', NOW)).toBe('done');
    expect(s.claim).toHaveBeenCalledWith('u1', 'a1', '2026-10-08', DAILY_TRANSCRIPTIONS);
    expect(claude).toHaveBeenCalledWith({
      kind: 'image',
      bytes: Uint8Array.from([9]),
      mediaType: 'image/jpeg',
    });
    expect(s.writeNote).toHaveBeenCalledWith(
      'u1',
      'Transcription of Whiteboard\n\n![Whiteboard](attachment:a1)\n\n✳ Claude’s transcription:\n\n- [ ] buy milk\n- [x] call Vik',
      'Transcription of Whiteboard',
    );
    expect(s.finish).toHaveBeenCalledWith('u1', 'a1', {
      transcribe: 'done',
      transcriptNoteId: 'n9',
    });
  });

  it('sends a PDF as a document, linked as a file chip', async () => {
    const s = store({
      status: 'claimed',
      record: { kind: 'pdf', name: 'Receipt.pdf', path: 'p', transcribe: 'requested' },
    });
    const prep = vi.fn();
    const claude = vi.fn(async (_input: TranscribeInput) => 'Total 12.40');
    expect(await transcribe(s, claude, prep, 'u1', 'a2', NOW)).toBe('done');
    expect(prep).not.toHaveBeenCalled();
    expect(claude.mock.calls[0][0]).toMatchObject({ kind: 'pdf', mediaType: 'application/pdf' });
    expect(s.writeNote.mock.calls[0][1]).toContain('[Receipt.pdf](attachment:a2)');
  });

  it('stops at the daily cap, and says so', async () => {
    const s = store({ status: 'capped' });
    const claude = vi.fn();
    expect(await transcribe(s, claude, vi.fn(), 'u1', 'a1', NOW)).toBe('capped');
    expect(claude).not.toHaveBeenCalled();
    expect(s.finish.mock.calls[0][2]).toMatchObject({ transcribe: 'failed' });
    expect(String(s.finish.mock.calls[0][2]['transcribeError'])).toContain('used up');
  });

  it('says why it could not, and leaves a claimed-elsewhere request alone', async () => {
    const failing = store({ status: 'claimed', record: photo });
    const heic = vi.fn(async () => {
      throw new Error('unsupported image format');
    });
    expect(await transcribe(failing, vi.fn(), heic, 'u1', 'a1', NOW)).toBe('failed');
    expect(failing.finish).toHaveBeenCalledWith('u1', 'a1', {
      transcribe: 'failed',
      transcribeError: 'unsupported image format',
    });
    expect(failing.writeNote).not.toHaveBeenCalled();

    const skipped = store({ status: 'skip' });
    expect(await transcribe(skipped, vi.fn(), vi.fn(), 'u1', 'a1', NOW)).toBe('skipped');
    expect(skipped.finish).not.toHaveBeenCalled();

    const unset = store({ status: 'claimed', record: photo });
    expect(await transcribe(unset, null, vi.fn(), 'u1', 'a1', NOW)).toBe('failed');
    expect(unset.claim).not.toHaveBeenCalled();
    expect(String(unset.finish.mock.calls[0][2]['transcribeError'])).toContain('not set up');
  });
});

describe('transcript helpers', () => {
  it('names the day in UTC and keeps a name link-safe', () => {
    expect(dayOf(NOW)).toBe('2026-10-08');
    expect(transcriptBody('a', 'a [b] c', 'image', ' x ')).toContain('![a b c](attachment:a)');
  });
});
