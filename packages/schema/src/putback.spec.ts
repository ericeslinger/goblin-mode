import { describe, expect, it } from 'vitest';
import { canPutBack, putBackDepth, putBackId } from './putback';

describe('put back ids', () => {
  it('derives a put back’s id from its run, and reads the depth back', () => {
    expect(putBackId('abc')).toBe('putback-abc');
    expect(putBackDepth('abc')).toEqual({ base: 'abc', depth: 0 });
    expect(putBackDepth(putBackId(putBackId('abc')))).toEqual({ base: 'abc', depth: 2 });
  });

  it('offers Put back for runs that touched notes History can undo', () => {
    expect(canPutBack({ tool: 'add_lines', notes: [{}] })).toBe(true);
    expect(canPutBack({ tool: 'put_back', notes: [{}] })).toBe(true);
    expect(canPutBack({ tool: 'create_reminder', notes: [] })).toBe(false);
    // Filing and a finished queue item, once their records keep what they replaced (#206).
    expect(canPutBack({ tool: 'refile', notes: [{}] })).toBe(false);
    expect(canPutBack({ tool: 'finish_queued', notes: [{}] })).toBe(false);
    expect(canPutBack({ tool: 'refile', notes: [{ before: { tags: ['clay'] } }] })).toBe(true);
    expect(
      canPutBack({ tool: 'finish_queued', notes: [{ before: { sendState: 'queued' } }] }),
    ).toBe(true);
    expect(canPutBack({ tool: 'refile', notes: [{ before: {} }, {}] })).toBe(false);
  });
});
